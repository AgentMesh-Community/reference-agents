#!/usr/bin/env node
// The board worker conformance check (spec/board-v1.md, section 6).
//
// Runs one worker against a mesh of its own: a local nats-server, a stand-in
// for the rooms service (the room's drive and work board), a test runner
// inviting as board.demo@agentmesh.ai, and a stranger. The shift is a fixed
// one, so the worker starts no harness and calls no model: it hands each file
// in as it found it. The seven cases are listed in spec/board-v1.md.
//
//   node board-check.mjs ../board/codex
//   node board-check.mjs --cmd "node agent.mjs" --handle me.you@example.com --harness mine
//
// Options:
//   --json         print the result as JSON as well
//   --show-logs    print the worker's own output at the end
//
// The worker is started with these settings, and a worker written for this
// check reads them:
//   AGENTMESH_SERVERS      the local mesh: a ws:// and a nats:// address, comma separated
//   AGENTMESH_AGENT_SEED   the worker's key for this run (a throwaway)
//   BOARD_HANDLE           the worker's handle
//   BOARD_LOCAL=1          no naming service: connect without the naming rule
//   BOARD_DIRECTORY        a JSON file mapping handles to agent keys, used in
//                          place of the naming service
// and it prints a line containing "board worker ready" once it is listening.
//
// Needs node 22 or newer and nats-server (on PATH, or at $NATS_SERVER_BIN).

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, connect as tcpConnect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect as natsConnect } from "nats.ws";
import { AgentMesh, createAgentIdentity, createEnvelope, keyPairFromSeed, signEnvelope } from "agentmesh";

const RUNNER = "board.demo@agentmesh.ai";
const GATEWAY = "models.platform@agentmesh.ai";
const READY_MS = 120_000;
const ANSWER_MS = 30_000;
const WORK_MS = 60_000;
const QUIET_MS = 4_000;

const PROJECT = {
  "README.md": "# Check project\n\nThree functions, one per file.\n",
  "add.ts": "export function add(a: number, b: number): number {\n  throw new Error(\"not written\");\n}\n",
  "add.test.ts": "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { add } from \"./add.ts\";\ntest(\"add\", () => assert.equal(add(2, 3), 5));\n",
  "double.ts": "export function double(n: number): number {\n  throw new Error(\"not written\");\n}\n",
  "double.test.ts": "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { double } from \"./double.ts\";\ntest(\"double\", () => assert.equal(double(4), 8));\n",
  "greet.ts": "export function greet(name: string): string {\n  throw new Error(\"not written\");\n}\n",
  "greet.test.ts": "import { test } from \"node:test\";\nimport assert from \"node:assert/strict\";\nimport { greet } from \"./greet.ts\";\ntest(\"greet\", () => assert.equal(greet(\"Ada\"), \"Hello, Ada\"));\n",
};
const ITEMS = [["add", "add.ts"], ["double", "double.ts"], ["greet", "greet.ts"]];

// ── arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = { json: false, showLogs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") o.json = true;
    else if (a === "--show-logs") o.showLogs = true;
    else if (a === "--cmd") o.cmd = argv[++i];
    else if (a === "--handle") o.handle = argv[++i];
    else if (a === "--harness") o.harness = argv[++i];
    else if (a === "--cwd") o.cwd = argv[++i];
    else if (!a.startsWith("--") && !o.folder) o.folder = a;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.folder) {
    const dir = resolve(o.folder);
    const file = join(dir, "board-worker.json");
    if (!existsSync(file)) throw new Error(`${file} not found: a worker folder carries a board-worker.json`);
    const m = JSON.parse(readFileSync(file, "utf8"));
    o.cwd ??= dir;
    o.cmd ??= m.start;
    o.handle ??= m.handle;
    o.harness ??= m.harness;
  }
  if (!o.cmd || !o.handle || !o.harness) {
    throw new Error("usage: board-check.mjs <worker folder>  or  --cmd <command> --handle <handle> --harness <name>");
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

// ── a stand-in for the rooms service: the drive and the work board ──────────

async function startRooms(wsUrl) {
  const me = createAgentIdentity();
  const kp = keyPairFromSeed(me.seed);
  const nc = await natsConnect({ servers: wsUrl });
  const rooms = new Map();
  const calls = [];
  const opts = { takeFirstClaim: false };
  let firstClaimSeen = false;
  const roomOf = (p) => {
    const id = String(p?.descriptor?.room_id ?? "");
    if (!rooms.has(id)) rooms.set(id, { files: [], items: [] });
    return rooms.get(id);
  };
  const answer = (msg, req, payload, error) => {
    const env = signEnvelope(createEnvelope({ type: "respond", from: me.publicKey, to: req.from, in_reply_to: req.id, ...(error ? { error } : { payload }) }), kp);
    msg.respond(new TextEncoder().encode(JSON.stringify(env)));
  };
  const counts = (items) => ({ items, open: items.filter((i) => i.state === "open").length, claimed: items.filter((i) => i.state === "claimed").length, done: items.filter((i) => i.state === "done").length });
  const handle = (subject, req) => {
    const p = req.payload ?? {};
    const r = roomOf(p);
    calls.push({ subject, from: req.from, room: String(p?.descriptor?.room_id ?? ""), payload: p, at: Date.now() });
    switch (subject) {
      case "mesh.rooms.provision": return { payload: { ok: true, room_id: p.descriptor?.room_id } };
      case "mesh.rooms.attach": {
        const data = Buffer.from(String(p.data_b64 ?? ""), "base64");
        const ref = `mesh:rooms:${p.descriptor?.room_id}/drive/${randomUUID()}`;
        const digest = `sha256:${createHash("sha256").update(data).digest("hex")}`;
        r.files.push({ ref, name: p.name, version: p.version ?? "1", digest, media_type: p.media_type ?? null, size: data.length, attached_by: req.from, attached_at: new Date().toISOString(), origin: p.origin ?? null, external: null, data_b64: p.data_b64 });
        return { payload: { ref, digest, size: data.length, media_type: p.media_type ?? null } };
      }
      case "mesh.rooms.status": return { payload: { drive: { artifacts: r.files.map(({ data_b64: _d, ...f }) => f) } } };
      case "mesh.rooms.fetch": {
        const f = r.files.find((x) => x.ref === p.ref);
        if (!f) return { error: { code: "NOT_FOUND", message: "no such file", retryable: false } };
        return { payload: f };
      }
      case "mesh.board.post": {
        const item = { item_id: randomUUID(), room_id: p.descriptor?.room_id, title: p.title, detail: p.detail, offering: p.offering, posted_by: req.from, posted_at: new Date().toISOString(), lease_ms: p.lease_ms ?? 3600000, state: "open", claimed_by: null, artifacts: [], claims: [] };
        r.items.push(item);
        return { payload: { item } };
      }
      case "mesh.board.list": return { payload: counts(r.items) };
      case "mesh.board.claim": {
        const it = r.items.find((x) => x.item_id === p.item_id);
        if (!it) return { error: { code: "NOT_FOUND", message: "no such item", retryable: false } };
        if (opts.takeFirstClaim && !firstClaimSeen) {
          firstClaimSeen = true;
          it.state = "claimed";
          it.claimed_by = "USOMEBODYELSE";
        }
        if (it.state !== "open") return { error: { code: "BOARD_ITEM_TAKEN", message: `BOARD_ITEM_TAKEN: held by ${it.claimed_by}`, retryable: false } };
        it.state = "claimed";
        it.claimed_by = req.from;
        return { payload: { item: it } };
      }
      case "mesh.board.complete": {
        const it = r.items.find((x) => x.item_id === p.item_id);
        if (!it || it.claimed_by !== req.from || it.state !== "claimed") return { error: { code: "IDENTITY_MISMATCH", message: "not the current claimer", retryable: false } };
        it.state = "done";
        it.artifacts = Array.isArray(p.artifacts) ? p.artifacts : [];
        it.result_note = p.note ?? null;
        return { payload: { item: it } };
      }
      case "mesh.board.abandon": {
        const it = r.items.find((x) => x.item_id === p.item_id);
        if (!it || it.claimed_by !== req.from) return { error: { code: "IDENTITY_MISMATCH", message: "not the current claimer", retryable: false } };
        it.state = "open";
        it.claimed_by = null;
        return { payload: { item: it } };
      }
      default: return { payload: {} };
    }
  };
  for (const pattern of ["mesh.rooms.>", "mesh.board.>"]) {
    const sub = nc.subscribe(pattern);
    (async () => {
      for await (const msg of sub) {
        if (!msg.reply) continue;
        let req;
        try { req = JSON.parse(new TextDecoder().decode(msg.data)); } catch { continue; }
        const out = handle(msg.subject, req);
        answer(msg, req, out.payload, out.error);
      }
    })();
  }
  return { rooms, calls, opts, close: () => nc.close() };
}

// ── the test's own agents ───────────────────────────────────────────────────

async function testAgent(url, name) {
  const id = createAgentIdentity();
  const mesh = await AgentMesh.connect(url, { nkeySeed: id.seed, requireNamed: false, fenceInbound: false });
  await mesh.register({ name, offerings: [{ id: "chat", name: "chat", description: "board-check test agent" }] });
  return { id: id.publicKey, mesh };
}

/** A shift room as the runner makes it: the project on the drive, three items posted. */
async function shiftRoom(agent) {
  const room = await agent.mesh.openRoom({ durable: true, name: `check ${randomUUID().slice(0, 6)}` });
  for (const [name, text] of Object.entries(PROJECT)) await room.attach(name, new TextEncoder().encode(text), { media_type: "text/plain", role: "input" });
  for (const [fn, file] of ITEMS) await room.postWork({ title: `Write ${fn} in ${file}`, detail: `Write ${fn}.`, offering: "board.code", lease_ms: 600_000 });
  return room;
}

async function invite(room, key, note) {
  try {
    const r = await room.invite(key, note);
    const out = r?.payload?.output ?? r?.output ?? r;
    return { status: r?.payload?.status ?? "completed", output: out, message: r?.payload?.message ?? null };
  } catch (err) {
    return { status: /reject/i.test(String(err?.code ?? err?.name ?? "")) || /refus|not the board runner/i.test(String(err?.message)) ? "rejected" : "error", message: err?.message ?? String(err) };
  }
}

async function ask(from, to, offering, input) {
  try {
    const r = await from.mesh.request(to, offering, input, { timeout_ms: ANSWER_MS });
    return { status: r.payload?.status ?? null, output: r.payload?.output ?? null, message: r.payload?.message ?? null };
  } catch (err) {
    return { status: "error", error: err?.message ?? String(err) };
  }
}

// ── the worker under test ───────────────────────────────────────────────────

function startWorker(o, env) {
  const proc = spawn(o.cmd, { cwd: o.cwd, shell: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  let ready = false;
  let exited = null;
  proc.stdout.on("data", (d) => { log += d; if (/board worker ready/i.test(log.slice(-600))) ready = true; });
  proc.stderr.on("data", (d) => { log += d; });
  proc.on("exit", (code) => { exited = code ?? "signal"; });
  return {
    get log() { return log; },
    async ready() {
      const deadline = Date.now() + READY_MS;
      while (Date.now() < deadline) {
        if (ready) return true;
        if (exited !== null) throw new Error(`the worker exited (${exited}) before it was ready:\n${log.slice(-3000)}`);
        await sleep(200);
      }
      throw new Error(`the worker did not say "board worker ready" within ${READY_MS / 1000}s:\n${log.slice(-3000)}`);
    },
    stop() {
      if (exited !== null) return;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/t", "/f"], { stdio: "ignore" });
      else proc.kill("SIGTERM");
    },
  };
}

async function until(fn, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = fn();
    if (v) return v;
    await sleep(200);
  }
  return fn();
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), "board-check-"));
  const nats = await startNats(dir);
  const rooms = await startRooms(nats.ws);
  const results = [];
  let worker = null;
  const agents = [];
  try {
    const R = await testAgent(nats.ws, "board-check-runner");
    const S = await testAgent(nats.ws, "board-check-stranger");
    const G = await testAgent(nats.ws, "board-check-gateway");
    agents.push(R, S, G);
    const W = createAgentIdentity();
    const directory = { [RUNNER]: R.id, [GATEWAY]: G.id, [o.handle]: W.publicKey };
    const dirFile = join(dir, "directory.json");
    writeFileSync(dirFile, JSON.stringify(directory, null, 2));

    worker = startWorker(o, {
      AGENTMESH_SERVERS: `${nats.ws},${nats.tcp}`,
      AGENTMESH_AGENT_SEED: W.seed,
      BOARD_HANDLE: o.handle,
      BOARD_LOCAL: "1",
      BOARD_DIRECTORY: dirFile,
      BOARD_RUNNER: RUNNER,
      BOARD_GATEWAY: GATEWAY,
    });
    await worker.ready();

    const run = async (id, fn) => {
      let problems;
      try { problems = await fn(); } catch (err) { problems = [`the check itself failed: ${err?.message ?? err}`]; }
      results.push({ case: id, pass: problems.length === 0, problems });
    };
    const byWorker = (subject, roomId) => rooms.calls.filter((c) => c.from === W.publicKey && c.subject === subject && (!roomId || c.room === roomId));

    await run("refuses-invite-from-stranger", async () => {
      const room = await shiftRoom(S);
      const ans = await invite(room, W.publicKey, "board-shift-v1 fixed");
      const bad = [];
      if (ans.status !== "rejected") bad.push(`answered ${JSON.stringify(ans).slice(0, 200)}, expected a refusal "not the board runner"`);
      else if (!/not the board runner/i.test(String(ans.message))) bad.push(`refused with "${ans.message}", expected "not the board runner"`);
      await sleep(QUIET_MS);
      if (rooms.calls.some((c) => c.from === W.publicKey && c.room === room.id)) bad.push("the worker touched the stranger's room after refusing the invite");
      return bad;
    });

    rooms.opts.takeFirstClaim = true;
    const shift = await shiftRoom(R);
    let invited = null;
    await run("joins-when-invited", async () => {
      invited = await invite(shift, W.publicKey, "board-shift-v1 fixed");
      if (invited.status !== "completed" || invited.output?.ok !== true) return [`answered ${JSON.stringify(invited).slice(0, 200)}, expected {"ok": true}`];
      const looked = await until(() => byWorker("mesh.board.list", shift.id).length > 0, WORK_MS);
      return looked ? [] : [`the worker did not read the room's board within ${WORK_MS / 1000}s`];
    });

    await until(() => byWorker("mesh.board.complete", shift.id).length > 0, WORK_MS);
    const claims = byWorker("mesh.board.claim", shift.id);
    const completes = byWorker("mesh.board.complete", shift.id);
    const items = rooms.rooms.get(shift.id)?.items ?? [];

    await run("moves-on-when-taken", async () => {
      if (claims.length < 2) return [`the worker made ${claims.length} claim(s); after the first was taken it should have claimed another item`];
      if (claims[1].payload.item_id === claims[0].payload.item_id) return ["after its first claim was taken, the worker claimed the same item again"];
      return [];
    });

    await run("one-claim-at-a-time", async () => {
      if (!completes.length) return ["the worker never completed an item"];
      const won = claims[1];
      if (!won) return ["the worker never won a claim"];
      const between = claims.filter((c) => c.at > won.at && c.at < completes[0].at);
      return between.length ? [`the worker claimed ${between.length} more item(s) before handing in the one it held`] : [];
    });

    await run("fetches-the-project", async () => {
      const files = rooms.rooms.get(shift.id)?.files ?? [];
      const fetched = new Set(byWorker("mesh.rooms.fetch", shift.id).map((c) => files.find((f) => f.ref === c.payload.ref)?.name));
      const item = items.find((i) => i.item_id === claims[1]?.payload.item_id);
      const file = item ? /in ([a-z0-9-]+\.ts)/.exec(item.title)?.[1] : null;
      const want = ["README.md", file, file?.replace(/\.ts$/, ".test.ts")].filter(Boolean);
      const missing = want.filter((n) => !fetched.has(n));
      return missing.length ? [`the worker did not fetch ${missing.join(", ")} from the room's drive`] : [];
    });

    await run("hands-in-its-file", async () => {
      const c = completes[0];
      if (!c) return ["the worker never completed an item"];
      const bad = [];
      if (c.payload.item_id !== claims[1]?.payload.item_id) bad.push("the worker completed an item it did not hold");
      const refs = Array.isArray(c.payload.artifacts) ? c.payload.artifacts : [];
      if (refs.length !== 1) bad.push(`the completion carried ${refs.length} files, expected 1`);
      const file = (rooms.rooms.get(shift.id)?.files ?? []).find((f) => f.ref === refs[0]);
      if (!file) bad.push("the completion names a file that is not on the room's drive");
      else {
        if (file.attached_by !== W.publicKey) bad.push("the file was attached by someone other than the worker");
        const item = items.find((i) => i.item_id === c.payload.item_id);
        const target = item ? /in ([a-z0-9-]+\.ts)/.exec(item.title)?.[1] : null;
        const text = Buffer.from(file.data_b64, "base64").toString("utf8");
        if (!target || text !== PROJECT[target]) bad.push("in a fixed shift the worker hands the item's file in as it found it; the file differs");
        if (!String(file.name).endsWith(target ?? ".ts")) bad.push(`the file is named ${file.name}, which does not end with ${target}`);
      }
      return bad;
    });

    await run("declares-harness", async () => {
      const ans = await ask(R, W.publicKey, "board.about", {});
      if (ans.status !== "completed" || !ans.output || typeof ans.output !== "object") return [`board.about answered ${JSON.stringify(ans)}`];
      const a = ans.output;
      const bad = [];
      if (a.role !== "board-worker" || a.role_version !== 1) bad.push(`role is ${JSON.stringify(a.role)} v${a.role_version}, expected board-worker v1`);
      if (a.harness !== o.harness) bad.push(`harness is ${JSON.stringify(a.harness)}, expected ${JSON.stringify(o.harness)}`);
      if (String(a.handle ?? "").toLowerCase() !== o.handle.toLowerCase()) bad.push(`handle is ${JSON.stringify(a.handle)}`);
      if (typeof a.vendor !== "string" || !a.vendor.trim()) bad.push("vendor is missing");
      if (!["anthropic", "openai", "gemini"].includes(a.api)) bad.push(`api is ${JSON.stringify(a.api)}, expected anthropic, openai or gemini`);
      if (a.via !== "gateway") bad.push(`via is ${JSON.stringify(a.via)}, expected "gateway"`);
      return bad;
    });
  } catch (err) {
    results.push({ case: "setup", pass: false, problems: [err?.message ?? String(err)] });
  } finally {
    worker?.stop();
    for (const a of agents) await a.mesh.close().catch(() => {});
    await rooms.close().catch(() => {});
    nats.stop();
    await sleep(300);
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* a file still held open on Windows */ }
  }

  const passed = results.filter((r) => r.pass).length;
  const conforms = results.length === 7 && results.every((r) => r.pass);
  console.log(`Board worker check: ${o.handle} (${o.harness}), fixed shift`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.case}`);
    for (const p of r.problems) console.log(`        ${p}`);
  }
  console.log(conforms ? `Conforms: all seven cases pass (${passed}/${results.length} run).` : `Does not conform: ${passed} of ${results.length} passed.`);
  if (o.showLogs && worker) console.log(`\n--- the worker's output ---\n${worker.log}`);
  if (o.json) console.log(JSON.stringify({ handle: o.handle, harness: o.harness, conforms, results }, null, 2));
  process.exit(conforms ? 0 : 1);
}

main().catch((err) => { console.error(err?.message ?? err); process.exit(2); });
