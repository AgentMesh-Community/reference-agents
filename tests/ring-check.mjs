#!/usr/bin/env node
// The Ring member conformance check (spec/ring-v1.md, section 6).
//
// Runs one member against a mesh of its own: a local nats-server, a test
// runner signing routes as ring.demo@agentmesh.ai, and two test peers.
// Fixed mode only, so no model is called. The seven cases and what each
// expects are in spec/fixed-mode-expected.json.
//
//   node ring-check.mjs ../frameworks/crewai
//   node ring-check.mjs --cmd "python my_agent.py" --handle me.you@example.com --framework mine
//
// Options:
//   --json         print the result as JSON as well
//   --live-stub    also run one live-mode lap against a stub gateway that
//                  answers with a fixed sentence (no model is called); this
//                  exercises the member's framework path and is not part of
//                  the role's conformance
//   --show-logs    print the member's own output at the end
//
// The member is started with these settings, and a member written for this
// check reads them:
//   AGENTMESH_SERVERS      the local mesh: a ws:// and a nats:// address, comma separated
//   AGENTMESH_AGENT_SEED   the member's key for this run (a throwaway)
//   RING_HANDLE            the member's handle
//   RING_LOCAL=1           no naming service: connect without the naming rule
//   RING_DIRECTORY         a JSON file mapping handles to agent keys, used in
//                          place of the naming service
// and it prints a line containing "ring member ready" once it is listening.
//
// Needs node 22 or newer and nats-server (on PATH, or at $NATS_SERVER_BIN).

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { AgentMesh, canonicalJSON, createAgentIdentity, keyPairFromSeed, signTagged } from "agentmesh";

const ROUTE_TAG = "agentmesh-ring-route-v1\n";
const RUNNER = "ring.demo@agentmesh.ai";
const GATEWAY = "models.platform@agentmesh.ai";
const PEER_A = "peer-a.ring-check@example.com";
const PEER_B = "peer-b.ring-check@example.com";
const READY_MS = 180_000;   // a Python member importing its framework can take a while on a cold runner
const ANSWER_MS = 30_000;
const HANDOFF_MS = 30_000;
const QUIET_MS = 2_500;     // how long "nothing is sent" is watched for

// ── arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { json: false, liveStub: false, showLogs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--live-stub") o.liveStub = true;
    else if (a === "--show-logs") o.showLogs = true;
    else if (a === "--cmd") o.cmd = argv[++i];
    else if (a === "--handle") o.handle = argv[++i];
    else if (a === "--framework") o.framework = argv[++i];
    else if (a === "--cwd") o.cwd = argv[++i];
    else if (!a.startsWith("--") && !o.folder) o.folder = a;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.folder) {
    const dir = resolve(o.folder);
    const file = join(dir, "ring-member.json");
    if (!existsSync(file)) throw new Error(`${file} not found: a member folder carries a ring-member.json`);
    const m = JSON.parse(readFileSync(file, "utf8"));
    o.cwd ??= dir;
    o.cmd ??= m.start;
    o.handle ??= m.handle;
    o.framework ??= m.framework;
  }
  if (!o.cmd || !o.handle || !o.framework) {
    throw new Error("usage: ring-check.mjs <member folder>  or  --cmd <command> --handle <handle> --framework <name>");
  }
  o.cwd ??= process.cwd();
  return o;
}

// ── a local mesh ────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.unref();
    s.on("error", fail);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => ok(port)); });
  });
}

function reachable(port) {
  return new Promise((ok) => {
    const c = tcpConnect(port, "127.0.0.1");
    c.on("connect", () => { c.destroy(); ok(true); });
    c.on("error", () => ok(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startNats(dir) {
  const bin = process.env.NATS_SERVER_BIN || "nats-server";
  const port = await freePort();
  const wsPort = await freePort();
  // TCP for the Python SDK, WebSocket for the TypeScript SDK (which speaks
  // only WebSocket, as it does on the real mesh at wss://mesh.agentmesh.ai).
  const conf = join(dir, "nats.conf");
  writeFileSync(conf, [
    `listen: "127.0.0.1:${port}"`,
    `jetstream { store_dir: ${JSON.stringify(join(dir, "js"))} }`,
    `websocket { listen: "127.0.0.1:${wsPort}", no_tls: true }`,
    "",
  ].join("\n"));
  const proc = spawn(bin, ["-c", conf], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
  const failed = new Promise((_, fail) => proc.on("error", (e) => fail(new Error(`nats-server did not start (${e.message}); put it on PATH or set NATS_SERVER_BIN`))));
  const up = (async () => {
    for (let i = 0; i < 100; i++) { if (await reachable(port)) return; await sleep(100); }
    throw new Error(`nats-server did not listen on ${port}: ${err.trim().split("\n").pop() ?? ""}`);
  })();
  await Promise.race([up, failed]);
  for (let i = 0; i < 50 && !(await reachable(wsPort)); i++) await sleep(100);
  return { ws: `ws://127.0.0.1:${wsPort}`, tcp: `nats://127.0.0.1:${port}`, stop: () => proc.kill() };
}

// ── the test's own agents ───────────────────────────────────────────────────

const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

function signRoute(route, seed) {
  const { sig: _drop, ...unsigned } = route;
  return { ...unsigned, sig: b64url(signTagged(keyPairFromSeed(seed), ROUTE_TAG, canonicalJSON(unsigned))) };
}

/** One test agent: connects, listens, and records every pass it is handed. */
async function testAgent(url, name, offerings, answer) {
  const id = createAgentIdentity();
  const mesh = await AgentMesh.connect(url, { nkeySeed: id.seed, requireNamed: false, fenceInbound: false });
  const got = [];
  const waiters = [];
  for (const offering of offerings) {
    mesh.onRequest(offering, async (input, ctx) => {
      const item = { offering, from: ctx.envelope.from, input, at: Date.now() };
      got.push(item);
      for (const w of waiters.splice(0)) w();
      return answer ? answer(offering, input) : { ok: true };
    });
  }
  await mesh.register({ name, offerings: offerings.map((o) => ({ id: o, name: o, description: "ring-check test agent" })) });
  return {
    id: id.publicKey, seed: id.seed, mesh, got,
    clear() { got.length = 0; },
    async next(ms) {
      if (got.length) return got.shift();
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        await Promise.race([new Promise((r) => waiters.push(r)), sleep(Math.max(0, deadline - Date.now()))]);
        if (got.length) return got.shift();
      }
      return null;
    },
  };
}

// ── the member under test ───────────────────────────────────────────────────

function startMember(o, env) {
  const proc = spawn(o.cmd, { cwd: o.cwd, shell: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  let ready = false;
  let exited = null;
  const onData = (d) => { log += d; if (/ring member ready/i.test(String(d)) || /ring member ready/i.test(log.slice(-400))) ready = true; };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", (d) => { log += d; });
  proc.on("exit", (code) => { exited = code ?? "signal"; });
  return {
    get log() { return log; },
    async ready() {
      const deadline = Date.now() + READY_MS;
      while (Date.now() < deadline) {
        if (ready) return true;
        if (exited !== null) throw new Error(`the member exited (${exited}) before it was ready:\n${log.slice(-3000)}`);
        await sleep(200);
      }
      throw new Error(`the member did not say "ring member ready" within ${READY_MS / 1000}s:\n${log.slice(-3000)}`);
    },
    stop() {
      if (exited !== null) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" });
      else proc.kill("SIGTERM");
    },
  };
}

// ── the cases ───────────────────────────────────────────────────────────────

function lapFor(route, hop, story, mode = "fixed", model = "ring-check/none") {
  return {
    ring: "v1",
    lap_id: randomUUID(),
    hop,
    lap: { model, mode, opening: "The lighthouse keeper found a letter with no name on it.", started_at: new Date().toISOString() },
    route,
    story,
  };
}

function seedEntry(handle, framework, line) {
  return { by: handle, framework, line, at: new Date().toISOString(), ms: 1, tokens_in: 0, tokens_out: 0 };
}

async function ask(from, to, offering, input) {
  try {
    const r = await from.mesh.request(to, offering, input, { timeout_ms: ANSWER_MS });
    return { status: r.payload?.status ?? null, output: r.payload?.output ?? null, message: r.payload?.message ?? null };
  } catch (err) {
    return { status: "error", error: err?.message ?? String(err) };
  }
}

function checkEntry(entry, want) {
  const bad = [];
  for (const [k, v] of Object.entries(want)) if (entry?.[k] !== v) bad.push(`${k} is ${JSON.stringify(entry?.[k])}, expected ${JSON.stringify(v)}`);
  if (typeof entry?.at !== "string" || Number.isNaN(Date.parse(entry.at))) bad.push("at is not an ISO time");
  if (!Number.isInteger(entry?.ms) || entry.ms < 0) bad.push("ms is not a whole number of milliseconds");
  return bad;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), "ring-check-"));
  const nats = await startNats(dir);
  const results = [];
  let member = null;
  const agents = [];
  try {
    const R = await testAgent(nats.ws, "ring-check-runner", ["ring.done"]);
    const P = await testAgent(nats.ws, "ring-check-peer-a", ["ring.pass"]);
    const N = await testAgent(nats.ws, "ring-check-peer-b", ["ring.pass"]);
    const G = await testAgent(nats.ws, "ring-check-gateway", ["model.complete"], (_o, input) => ({
      text: "The keeper read it twice and put the kettle on.",
      model: input?.model ?? "stub",
      tokens_in: 11,
      tokens_out: 9,
      ms: 1,
    }));
    const X = createAgentIdentity(); // the impostor that signs a bad route
    agents.push(R, P, N, G);
    const C = createAgentIdentity();
    const directory = { [RUNNER]: R.id, [PEER_A]: P.id, [PEER_B]: N.id, [GATEWAY]: G.id, [o.handle]: C.publicKey };
    const dirFile = join(dir, "directory.json");
    writeFileSync(dirFile, JSON.stringify(directory, null, 2));

    member = startMember(o, {
      AGENTMESH_SERVERS: `${nats.ws},${nats.tcp}`,
      AGENTMESH_AGENT_SEED: C.seed,
      RING_HANDLE: o.handle,
      RING_LOCAL: "1",
      RING_DIRECTORY: dirFile,
      RING_RUNNER: RUNNER,
      RING_GATEWAY: GATEWAY,
    });
    await member.ready();

    const route = (members, seed = R.seed) => signRoute({ members, runner: RUNNER, issued_at: new Date().toISOString() }, seed);
    const fw = o.framework;
    const quiet = async (...who) => {
      await sleep(QUIET_MS);
      const heard = who.filter((a) => a.got.length);
      return heard.length ? [`something was sent after a refusal (${heard.map((a) => a.got[0].offering).join(", ")})`] : [];
    };
    const expectRefusal = (ans, words) => {
      if (ans.status !== "rejected") return [`answered ${JSON.stringify(ans)}, expected a refusal "${words}"`];
      return String(ans.message ?? "").toLowerCase().includes(words) ? [] : [`refused with "${ans.message}", expected "${words}"`];
    };
    const expectOk = (ans) => (ans.status === "completed" && ans.output?.ok === true ? [] : [`answered ${JSON.stringify(ans)}, expected {"ok": true}`]);
    const expectHandoff = async (target, want) => {
      const got = await target.next(HANDOFF_MS);
      if (!got) return [`nothing reached ${want.toName} within ${HANDOFF_MS / 1000}s`];
      const bad = [];
      if (got.offering !== want.offering) bad.push(`${want.toName} was sent ${got.offering}, expected ${want.offering}`);
      if (got.from !== C.publicKey) bad.push(`the ${got.offering} came from ${got.from.slice(0, 10)}..., not from the member`);
      const i = got.input ?? {};
      if (i.hop !== want.hop) bad.push(`hop is ${i.hop}, expected ${want.hop}`);
      if (i.lap_id !== want.lap_id) bad.push("lap_id changed");
      if (canonicalJSON(i.route) !== canonicalJSON(want.route)) bad.push("route changed");
      if (canonicalJSON(i.lap) !== canonicalJSON(want.lap)) bad.push("lap changed");
      if (!Array.isArray(i.story) || i.story.length !== want.storyLength) bad.push(`story has ${Array.isArray(i.story) ? i.story.length : "no"} entries, expected ${want.storyLength}`);
      else {
        for (let k = 0; k < want.storyLength - 1; k++) if (canonicalJSON(i.story[k]) !== canonicalJSON(want.before[k])) bad.push(`story entry ${k} was changed`);
        bad.push(...checkEntry(i.story[want.storyLength - 1], want.last));
      }
      return bad;
    };
    const run = async (id, fn) => {
      for (const a of agents) a.clear();
      let problems;
      try { problems = await fn(); } catch (err) { problems = [`the check itself failed: ${err?.message ?? err}`]; }
      results.push({ case: id, pass: problems.length === 0, problems });
    };

    await run("passes-on-correct-hop", async () => {
      const before = [seedEntry(PEER_A, "peer", "peer:0")];
      const lap = lapFor(route([PEER_A, o.handle, PEER_B]), 1, before);
      const ans = await ask(P, C.publicKey, "ring.pass", lap);
      const bad = expectOk(ans);
      if (bad.length) return bad;
      return expectHandoff(N, { toName: "the next member", offering: "ring.pass", hop: 2, lap_id: lap.lap_id, route: lap.route, lap: lap.lap, storyLength: 2, before,
        last: { by: o.handle, framework: fw, line: `${fw}:1`, tokens_in: 0, tokens_out: 0 } });
    });

    await run("refuses-bad-signature", async () => {
      const lap = lapFor(route([PEER_A, o.handle, PEER_B], X.seed), 1, [seedEntry(PEER_A, "peer", "peer:0")]);
      return [...expectRefusal(await ask(P, C.publicKey, "ring.pass", lap), "route signature invalid"), ...(await quiet(N, R, P))];
    });

    await run("refuses-wrong-sender", async () => {
      const lap = lapFor(route([PEER_A, o.handle, PEER_B]), 1, [seedEntry(PEER_A, "peer", "peer:0")]);
      return [...expectRefusal(await ask(N, C.publicKey, "ring.pass", lap), "wrong sender"), ...(await quiet(N, R, P))];
    });

    await run("refuses-wrong-hop", async () => {
      const lap = lapFor(route([PEER_A, o.handle, PEER_B]), 0, []);
      return [...expectRefusal(await ask(R, C.publicKey, "ring.pass", lap), "wrong hop"), ...(await quiet(N, R, P))];
    });

    await run("forwards-to-next-member", async () => {
      const lap = lapFor(route([o.handle, PEER_A, PEER_B]), 0, []);
      const ans = await ask(R, C.publicKey, "ring.pass", lap);
      const bad = expectOk(ans);
      if (bad.length) return bad;
      const got = await expectHandoff(P, { toName: "the next member", offering: "ring.pass", hop: 1, lap_id: lap.lap_id, route: lap.route, lap: lap.lap, storyLength: 1, before: [],
        last: { by: o.handle, framework: fw, line: `${fw}:0`, tokens_in: 0, tokens_out: 0 } });
      await sleep(QUIET_MS);
      if (N.got.length) got.push("the member also sent to a member that is not next");
      if (R.got.length) got.push("the member also sent to the runner");
      return got;
    });

    await run("sends-done-when-last", async () => {
      const before = [seedEntry(PEER_A, "peer", "peer:0")];
      const lap = lapFor(route([PEER_A, o.handle]), 1, before);
      const ans = await ask(P, C.publicKey, "ring.pass", lap);
      const bad = expectOk(ans);
      if (bad.length) return bad;
      return expectHandoff(R, { toName: "the runner", offering: "ring.done", hop: 1, lap_id: lap.lap_id, route: lap.route, lap: lap.lap, storyLength: 2, before,
        last: { by: o.handle, framework: fw, line: `${fw}:1`, tokens_in: 0, tokens_out: 0 } });
    });

    let declared = null;
    await run("declares-live-models", async () => {
      const ans = await ask(R, C.publicKey, "ring.about", {});
      if (ans.status !== "completed" || !ans.output || typeof ans.output !== "object") return [`ring.about answered ${JSON.stringify(ans)}`];
      const a = ans.output;
      const bad = [];
      if (a.role !== "ring-member" || a.role_version !== 1) bad.push(`role is ${JSON.stringify(a.role)} v${a.role_version}, expected ring-member v1`);
      if (a.framework !== fw) bad.push(`framework is ${JSON.stringify(a.framework)}, expected ${JSON.stringify(fw)}`);
      if (String(a.handle ?? "").toLowerCase() !== o.handle.toLowerCase()) bad.push(`handle is ${JSON.stringify(a.handle)}`);
      if (a.via !== "gateway" && a.via !== "harness") bad.push(`via is ${JSON.stringify(a.via)}, expected "gateway" or "harness"`);
      if (!Array.isArray(a.live_models) || !a.live_models.every((m) => typeof m === "string" && m.trim())) bad.push(`live_models is ${JSON.stringify(a.live_models)}, expected a list of model ids or patterns`);
      else {
        declared = a.live_models;
        // The same declaration as the ring.pass offering's tags on the card,
        // which is where a runner reads it.
        const want = [`ring-via:${a.via}`, ...a.live_models.map((m) => `ring-model:${m}`)].sort();
        const tags = Array.isArray(a.tags) ? [...a.tags].sort() : null;
        if (!tags || canonicalJSON(tags) !== canonicalJSON(want)) bad.push(`the ring.pass tags are ${JSON.stringify(a.tags)}, expected ${JSON.stringify(want)}`);
      }
      return bad;
    });

    if (o.liveStub) {
      const STUB_MODEL = "ring-check/stub-model";
      const covers = (declared ?? []).some((p) => p === "*" || p === STUB_MODEL || (p.endsWith("*") && STUB_MODEL.startsWith(p.slice(0, -1))));
      await run(`live-mode-with-stub-gateway, ${covers ? "writes a line" : "sits out"} (extra, not part of the role check)`, async () => {
        const before = [seedEntry(PEER_A, "peer", "The wind came up off the water.")];
        const lap = lapFor(route([PEER_A, o.handle, PEER_B]), 1, before, "live", STUB_MODEL);
        const ans = await ask(P, C.publicKey, "ring.pass", lap);
        const bad = expectOk(ans);
        if (bad.length) return bad;
        if (!covers) {
          const got = await N.next(HANDOFF_MS);
          if (!got) return ["nothing reached the next member"];
          const last = got.input?.story?.at(-1);
          const out = [];
          if (G.got.length) out.push("the member asked the gateway for a model it did not declare");
          if (!last || last.by !== o.handle || !/passes the story on/.test(String(last.line))) out.push(`the entry was ${JSON.stringify(last)}, expected the member to pass the story on`);
          return out;
        }
        const asked = await G.next(HANDOFF_MS * 4);
        if (!asked) return ["the member never asked the gateway for its line"];
        const q = asked.input ?? {};
        const qbad = [];
        if (asked.from !== C.publicKey) qbad.push("the gateway was asked by someone other than the member");
        if (q.lap_id !== lap.lap_id) qbad.push("model.complete carried the wrong lap_id");
        if (q.model !== lap.lap.model) qbad.push(`model.complete asked for ${q.model}, expected ${lap.lap.model}`);
        if (!Array.isArray(q.messages) || !q.messages.length) qbad.push("model.complete carried no messages");
        if (!Number.isInteger(q.max_tokens)) qbad.push("model.complete carried no max_tokens");
        const got = await N.next(HANDOFF_MS * 4);
        if (!got) return [...qbad, "nothing reached the next member"];
        const last = got.input?.story?.at(-1);
        if (!last || last.by !== o.handle) qbad.push("the next member did not get the member's entry");
        else {
          if (!String(last.line ?? "").includes("kettle")) qbad.push(`the line was ${JSON.stringify(last.line)}, not the gateway's sentence`);
          if (last.tokens_in !== 11 || last.tokens_out !== 9) qbad.push(`tokens are ${last.tokens_in}/${last.tokens_out}, expected the gateway's 11/9`);
        }
        return qbad;
      });
    }
  } catch (err) {
    results.push({ case: "setup", pass: false, problems: [err?.message ?? String(err)] });
  } finally {
    member?.stop();
    for (const a of agents) await a.mesh.close().catch(() => {});
    nats.stop();
    await sleep(300);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a file still held open on Windows */ }
  }

  const passed = results.filter((r) => r.pass).length;
  const roleCases = results.filter((r) => !r.case.startsWith("live-mode"));
  const conforms = roleCases.length === 7 && roleCases.every((r) => r.pass);
  console.log(`Ring member check: ${o.handle} (${o.framework}), fixed mode`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.case}`);
    for (const p of r.problems) console.log(`        ${p}`);
  }
  console.log(conforms ? `Conforms: all seven cases pass (${passed}/${results.length} run).` : `Does not conform: ${passed} of ${results.length} passed.`);
  if (o.showLogs && member) console.log(`\n--- the member's output ---\n${member.log}`);
  if (o.json) console.log(JSON.stringify({ handle: o.handle, framework: o.framework, conforms, results }, null, 2));
  process.exit(conforms && results.every((r) => r.pass) ? 0 : 1);
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(2); });
