// The board worker's part (spec/board-v1.md). The same file is in every
// folder under board/.
//
// A board worker is a coding agent that takes items off a room's work board.
// The runner, board.demo@agentmesh.ai, opens a room, puts a small project on
// its drive, posts one item per function to write, and invites the workers.
// A worker joins, claims an item (the board's claim lease means only one
// worker wins it), fetches the files, has its harness write the function,
// and completes the item with the file attached. The runner runs the tests.
//
// Only one thing differs between workers: the harness. Each folder's agent.mjs
// passes its own runHarness to runWorker. The harness speaks its vendor's own
// HTTP API to a relay on localhost that this file starts; the relay carries
// each call over the mesh to the model gateway (models.platform@agentmesh.ai,
// offering model.relay), which adds the key. So the worker holds no model key.
//
// Settings, all from the environment:
//   BOARD_HANDLE                this worker's handle (required)
//   AGENTMESH_CREDENTIALS_FILE  the credential bundle join.mjs wrote (on Cloud
//                               Run, the mounted secret), or
//   AGENTMESH_FOLDER            the folder join.mjs wrote
//   BOARD_RUNNER                the runner it takes invites from (board.demo@agentmesh.ai)
//   BOARD_GATEWAY               the model gateway (models.platform@agentmesh.ai)
//   BOARD_HARNESS_TIMEOUT_S     how long the harness may take on one item (420)
//   PORT                        when set (Cloud Run sets it), answer health checks there
//
// The conformance check sets BOARD_LOCAL=1, AGENTMESH_SERVERS,
// AGENTMESH_AGENT_SEED and BOARD_DIRECTORY instead; see tests/board-check.mjs.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  AgentMesh,
  CredentialRenewer,
  Diagnostics,
  RejectedError,
  canonicalJSON,
  jwtAuthenticator,
  keyPairFromSeed,
} from "agentmesh";

export const DEFAULT_RUNNER = "board.demo@agentmesh.ai";
export const DEFAULT_GATEWAY = "models.platform@agentmesh.ai";
export const SHIFT_NOTE = "board-shift-v1";
export const BOARD_PAGE = "https://agentmesh.ai/demos/board.html";
const POLL_MS = 8_000;
const MAX_SHIFT_MS = 40 * 60_000;
const IDLE_STOP_MS = 5 * 60_000;
const CLAIM_LEASE_MS = 10 * 60_000;
const RELAY_TIMEOUT_MS = 200_000;

export const nowIso = () => new Date().toISOString();
export const log = (msg) => console.log(`${nowIso()} ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── who is who ──────────────────────────────────────────────────────────────

class Keys {
  constructor(mesh, directory) {
    this.fixed = null;
    if (directory) {
      this.fixed = Object.fromEntries(Object.entries(JSON.parse(readFileSync(directory, "utf8"))).map(([k, v]) => [k.toLowerCase(), v]));
    }
    this.diag = new Diagnostics(mesh);
    this.cache = new Map();
  }
  async of(handle) {
    const h = String(handle).trim().toLowerCase();
    if (this.fixed) return this.fixed[h] ?? null;
    const hit = this.cache.get(h);
    if (hit && Date.now() - hit.at < 600_000) return hit.key;
    const r = await this.diag.resolve(h).catch(() => null);
    const key = r?.resolved ? r.agentId ?? null : null;
    if (key) this.cache.set(h, { key, at: Date.now() });
    return key;
  }
}

// ── connecting ──────────────────────────────────────────────────────────────

function parseCreds(text) {
  const jwt = /-----BEGIN NATS USER JWT-----\s*([^\s-][^\s]*)\s*------END NATS USER JWT------/.exec(text)?.[1];
  const seed = /-----BEGIN USER NKEY SEED-----\s*(SU[A-Z2-7]+)\s*------END USER NKEY SEED------/.exec(text)?.[1];
  if (!jwt || !seed) throw new Error("the credential file is not a NATS .creds file");
  return { jwt, seed };
}

/** The credential bundle. A bundle holding only the agent's key (its name is
 *  bound, it has not joined yet) is waited on: Cloud Run re-reads a secret
 *  mounted at "latest", so the credential is picked up when it is added. */
async function readBundle(path) {
  let said = 0;
  for (;;) {
    const d = JSON.parse(readFileSync(path, "utf8"));
    if (d.mesh_creds) return d;
    if (Date.now() - said > 600_000) { log("waiting for this agent's connection credential (the bundle has its key only)"); said = Date.now(); }
    await sleep(30_000);
  }
}

async function loadCredentials() {
  const bundle = process.env.AGENTMESH_CREDENTIALS_FILE;
  if (bundle) {
    const d = await readBundle(bundle);
    return { agentSeed: String(d.agent_seed).trim(), ...parseCreds(String(d.mesh_creds)), servers: d.servers ?? [], apiBase: d.api_base ?? "https://api.agentmesh.ai" };
  }
  const folder = process.env.AGENTMESH_FOLDER;
  if (!folder) throw new Error("Set AGENTMESH_CREDENTIALS_FILE or AGENTMESH_FOLDER (see this folder's README: node join.mjs am_...).");
  const meta = JSON.parse(readFileSync(join(folder, "mesh.json"), "utf8"));
  return {
    agentSeed: readFileSync(join(folder, "agent.seed"), "utf8").trim(),
    ...parseCreds(readFileSync(join(folder, "mesh.creds"), "utf8")),
    servers: meta.servers ?? [],
    apiBase: meta.api_base ?? "https://api.agentmesh.ai",
  };
}

/** Prefer the WebSocket endpoint: it is the one that works from anywhere, a
 *  Cloud Run container included, over port 443. */
const pickServers = (servers) => {
  const ws = servers.filter((s) => /^wss?:\/\//.test(s));
  return ws.length ? ws : servers;
};

async function connectMesh() {
  if (process.env.BOARD_LOCAL === "1") {
    return AgentMesh.connect(pickServers(String(process.env.AGENTMESH_SERVERS).split(",").filter(Boolean)), { nkeySeed: process.env.AGENTMESH_AGENT_SEED, requireNamed: false, fenceInbound: false });
  }
  const c = await loadCredentials();
  const agentId = keyPairFromSeed(c.agentSeed).getPublicKey();
  const renewer = new CredentialRenewer({ apiBase: c.apiBase, jwt: c.jwt, nodeSeed: c.seed, agents: [{ id: agentId, seed: c.agentSeed }] });
  if (renewer.status().expired) {
    log("the saved credential has lapsed; renewing it");
    c.jwt = (await renewer.renew()).jwt;
  }
  const chosen = String(process.env.AGENTMESH_SERVERS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return AgentMesh.connect(pickServers(chosen.length ? chosen : c.servers), {
    nkeySeed: c.agentSeed,
    authenticator: jwtAuthenticator(c.jwt, new TextEncoder().encode(c.seed)),
    jwt: c.jwt,
    credentialRenewal: { apiBase: c.apiBase, credentialSeed: c.seed },
    fenceInbound: false,
  });
}

// ── the relay: the harness's own API, carried over the mesh ─────────────────

const RELAY_HEADERS = ["anthropic-version", "anthropic-beta", "accept", "content-type"];

/** A relay on localhost for the harness. Each HTTP call it gets goes whole to
 *  the gateway as one model.relay request, and the answer comes back whole. */
export async function startRelay(mesh, gatewayKey, api) {
  // The gateway declares a larger inbound cap than the protocol's default on
  // its card; reading the card lets this side pre-flight against it.
  let cardRead = 0;
  const readCard = async (key) => {
    if (Date.now() - cardRead < 600_000) return;
    await mesh.getManifest(key).then(() => { cardRead = Date.now(); }, (err) => log(`the gateway's card could not be read: ${err?.message ?? err}`));
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = {};
    for (const k of RELAY_HEADERS) if (typeof req.headers[k] === "string") headers[k] = req.headers[k];
    const input = { relay: "v1", api, method: req.method === "GET" ? "GET" : "POST", path: req.url ?? "/", headers, body_gz_b64: gzipSync(Buffer.concat(chunks)).toString("base64") };
    try {
      const to = await gatewayKey();
      if (!to) throw new Error("the model gateway does not resolve");
      await readCard(to);
      const r = await mesh.request(to, "model.relay", input, { timeout_ms: RELAY_TIMEOUT_MS });
      const out = r.payload?.output;
      if (r.payload?.status !== "completed" || !out || typeof out.body_gz_b64 !== "string") {
        throw new Error(`the gateway answered ${r.payload?.status}: ${String(r.payload?.message ?? "").slice(0, 200)}`);
      }
      res.writeHead(Number(out.status) || 502, { "content-type": String(out.content_type || "application/json") });
      res.end(gunzipSync(Buffer.from(out.body_gz_b64, "base64")));
    } catch (err) {
      log(`relay ${req.method} ${String(req.url).slice(0, 60)}: ${err?.message ?? err}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "relay_error", message: String(err?.message ?? err) } }));
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// ── the work ────────────────────────────────────────────────────────────────

/** The file an item asks for, from its title: "Write parseDate in parse-date.ts". */
export function itemTarget(item) {
  const m = /^Write ([A-Za-z0-9_]+) in ([a-z0-9-]+\.ts)\b/.exec(String(item?.title ?? ""));
  return m ? { fn: m[1], file: m[2], test: m[2].replace(/\.ts$/, ".test.ts") } : null;
}

export function promptFor({ fn, file, test }) {
  return [
    "You are working in this folder, a small TypeScript project; README.md has the rules.",
    `Write the function ${fn} in ${file} so that the tests in ${test} pass.`,
    `Edit only ${file}, and keep its export name and signature.`,
    "Use plain TypeScript that node can run by stripping the types: no enum, no namespace, no parameter properties.",
    `You can run the tests with: node --experimental-strip-types --test ${test}`,
    "When the tests pass, stop.",
  ].join("\n");
}

const isTaken = (err) => String(err?.code ?? "") === "BOARD_ITEM_TAKEN" || /BOARD_ITEM_TAKEN|already claimed|taken/i.test(String(err?.message ?? ""));

/**
 * Run a board worker. `runHarness({ dir, fn, file, test, prompt, relayUrl,
 * timeoutMs })` has the harness edit `file` in `dir`; it is never called in a
 * fixed shift, where the worker hands the file in as it found it.
 */
export async function runWorker({ harness, vendor, api, runHarness, description, source = "" }) {
  const handle = String(process.env.BOARD_HANDLE ?? "").trim().toLowerCase();
  if (!handle) throw new Error("Set BOARD_HANDLE to this worker's handle, for example codex.demo@agentmesh.ai.");
  const runner = String(process.env.BOARD_RUNNER ?? DEFAULT_RUNNER).trim().toLowerCase();
  const gatewayHandle = String(process.env.BOARD_GATEWAY ?? DEFAULT_GATEWAY).trim().toLowerCase();
  const local = process.env.BOARD_LOCAL === "1";
  const harnessTimeoutMs = Math.max(30, Number(process.env.BOARD_HARNESS_TIMEOUT_S) || 420) * 1000;
  const name = handle.split("@")[0].split(".")[0];

  if (process.env.PORT) {
    createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("board worker\n"); })
      .listen(Number(process.env.PORT), "0.0.0.0", () => log(`health checks answered on port ${process.env.PORT}`));
  }
  const mesh = await connectMesh();
  const keys = new Keys(mesh, local ? process.env.BOARD_DIRECTORY : null);
  const relay = await startRelay(mesh, () => keys.of(gatewayHandle), api);
  const shifts = new Set();

  async function workItem(room, item, fixed, runnerKey) {
    const target = itemTarget(item);
    const dir = mkdtempSync(join(tmpdir(), "board-"));
    try {
      // The project, as the runner put it on the drive: its files only, newest of each name.
      const files = (await room.files()).filter((f) => f.attached_by === runnerKey);
      const newest = new Map();
      for (const f of files) {
        const had = newest.get(f.name);
        if (!had || String(f.attached_at) > String(had.attached_at)) newest.set(f.name, f);
      }
      for (const f of newest.values()) {
        if (!/^[a-z0-9][a-z0-9.-]*\.(ts|md)$/i.test(f.name)) continue;
        const got = await room.fetchArtifact(f.ref);
        writeFileSync(join(dir, f.name), Buffer.from(got.data));
      }
      if (!target || !newest.has(target.file)) throw new Error(`the item names no file on the drive (${item.title})`);
      const before = readFileSync(join(dir, target.file), "utf8");
      if (!fixed) {
        const t0 = Date.now();
        // A harness that stops with an error may still have written the
        // function: whatever is in the file is handed in, and the tests decide.
        await runHarness({ dir, ...target, prompt: promptFor(target), relayUrl: relay.url, timeoutMs: harnessTimeoutMs })
          .catch((err) => log(`${harness} stopped with an error on ${target.fn}: ${String(err?.message ?? err).slice(0, 300)}`));
        log(`${harness} worked on ${target.fn} for ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      const code = readFileSync(join(dir, target.file), "utf8");
      if (!fixed && code === before) throw new Error(`${harness} left ${target.file} as it was`);
      const att = await room.attach(`${name}-${target.file}`, new TextEncoder().encode(code), { media_type: "text/plain", role: "output", origin: `${harness} (${vendor})` });
      await room.completeWork(item.item_id, { note: `${harness} (${vendor}) wrote ${target.fn}.`, artifacts: [att.ref] });
      log(`completed ${item.item_id.slice(0, 8)} (${target.fn}) with ${att.ref}`);
    } catch (err) {
      log(`could not finish ${item.item_id.slice(0, 8)}: ${err?.message ?? err}; putting it back`);
      await room.abandonWork(item.item_id).catch(() => {});
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* still held */ }
    }
  }

  async function workShift(descriptor, fixed, runnerKey) {
    const roomId = String(descriptor?.room_id ?? "");
    if (shifts.has(roomId)) return;
    shifts.add(roomId);
    let room;
    try {
      room = await mesh.joinRoom(descriptor);
    } catch (err) {
      log(`could not join the room: ${err?.message ?? err}`);
      shifts.delete(roomId);
      return;
    }
    log(`joined shift room ${roomId.slice(0, 8)}${fixed ? " (fixed)" : ""}`);
    const tried = new Set();
    const started = Date.now();
    let lastWork = Date.now();
    try {
      while (Date.now() - started < MAX_SHIFT_MS) {
        let list;
        try {
          list = await room.boardItems();
        } catch (err) {
          log(`the shift's board is gone (${err?.message ?? err}); done`);
          break;
        }
        const items = Array.isArray(list?.items) ? list.items : [];
        const open = items.filter((i) => i.state === "open" && itemTarget(i));
        const busy = items.some((i) => i.state === "claimed");
        if (!open.length) {
          if (!busy && Date.now() - lastWork > IDLE_STOP_MS) break;
          await sleep(POLL_MS);
          continue;
        }
        // Items for functions it has not tried come first; one it tried waits a
        // round, so another worker can take it first.
        const fresh = open.filter((i) => !tried.has(itemTarget(i).fn));
        const pool = fresh.length ? fresh : open;
        if (!fresh.length && Date.now() - lastWork < POLL_MS * 2) { await sleep(POLL_MS); continue; }
        const pick = pool[Math.floor(Math.random() * pool.length)];
        let item;
        try {
          item = await room.claimWork(pick.item_id, CLAIM_LEASE_MS);
        } catch (err) {
          if (isTaken(err)) { log(`${pick.item_id.slice(0, 8)} was taken by another worker; looking again`); continue; }
          log(`claim failed: ${err?.message ?? err}`);
          await sleep(POLL_MS);
          continue;
        }
        tried.add(itemTarget(item ?? pick).fn);
        log(`claimed ${pick.item_id.slice(0, 8)}: ${pick.title}`);
        await workItem(room, { ...pick, ...(item ?? {}) }, fixed, runnerKey);
        lastWork = Date.now();
      }
    } finally {
      room.leave?.();
      shifts.delete(roomId);
    }
  }

  mesh.onRequest("rooms.invite", async (p, ctx) => {
    const runnerKey = await keys.of(runner);
    if (!runnerKey || ctx.envelope.from !== runnerKey) {
      log(`refused an invite from ${String(ctx.envelope.from).slice(0, 12)}...`);
      throw new RejectedError("not the board runner: this worker takes invites only from the board's runner");
    }
    const note = String(p?.note ?? "");
    if (!note.startsWith(SHIFT_NOTE) || !p?.descriptor || typeof p.descriptor !== "object") {
      throw new RejectedError("not a board shift: the invite carries no board-shift-v1 note and room");
    }
    const fixed = /\bfixed\b/.test(note);
    setImmediate(() => { workShift(p.descriptor, fixed, runnerKey).catch((err) => log(`shift: ${err?.message ?? err}`)); });
    return { ok: true, joined: true };
  });

  const about = { board: "v1", role: "board-worker", role_version: 1, handle, harness, vendor, api, via: "gateway" };
  mesh.onRequest("board.about", () => about);

  const listed = `${description}${source ? ` Source: ${source}.` : ""} Watch the shifts: ${BOARD_PAGE}.`;
  const offerings = [
    { id: "rooms.invite", name: "Board shift invite", tags: [`board-harness:${harness}`, `board-api:${api}`], description: "Takes an invite to a board shift from the board's runner, joins the room and works items off its board (role board-worker v1)." },
    { id: "board.about", name: "Board worker facts", description: "Says which harness and vendor this worker is and which model API it speaks." },
  ];
  await mesh.register({
    name,
    description: listed,
    offerings,
    visibility: "public",
    meta: { harness, vendor, roles: ["board-worker@1"] },
  });
  log(`board worker ready: ${handle} (${harness}, ${vendor}) as ${mesh.id}`);
  if (!local) void fileDescriptor(mesh, handle, listed, offerings);

  const stop = async () => { relay.close(); await mesh.close().catch(() => {}); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

/** File this agent's Agent Descriptor at the registry, signed by its own key.
 *  Best effort: the worker works the same without it. */
async function fileDescriptor(mesh, handle, does, offerings) {
  const body = {
    format: "agent-descriptor-v1",
    agent_version: "1.0.0",
    subject: { id: mesh.id, handle },
    does,
    interaction: "service",
    role: "board-worker",
    offerings: offerings.map((o) => ({ id: o.id, name: o.name, does: o.description })),
    refusals: "Refuses an invite from anyone but the board's runner, and an invite that is not a board shift.",
  };
  const sig = mesh.signDetached(`descriptor-statement-v1\n${canonicalJSON(body)}`);
  const doc = { ...body, signatures: [{ tag: "descriptor-statement-v1", by: mesh.id, sig }] };
  try {
    await mesh.serviceRequest("mesh.registry.descriptor.put", { descriptor: Buffer.from(JSON.stringify(doc)).toString("base64") }, 10_000);
    log("descriptor filed at the registry");
  } catch (err) {
    log(`descriptor not filed (${err?.message ?? err}); the worker works the same without it`);
  }
}

// ── running a harness ───────────────────────────────────────────────────────

/** Start a command, feed it `input`, and wait for it within `timeoutMs`. */
export function runCommand(cmd, args, { cwd, env, input = "", timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`${cmd} did not finish within ${Math.round(timeoutMs / 1000)}s`)); }, timeoutMs);
    child.stdout.on("data", (d) => { out = (out + d).slice(-20_000); });
    child.stderr.on("data", (d) => { err = (err + d).slice(-4_000); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`${cmd} could not start: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cmd} exited ${code}: ${(err.trim() || out.trim()).split("\n").slice(-2).join(" ").slice(0, 300)}`));
      resolve({ out, err });
    });
    child.stdin.end(input);
  });
}

/** A home folder of its own for one harness run, beside the project and
 *  removed after, so no run sees another's settings or history. */
export async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), "board-home-"));
  try {
    return await fn(home);
  } finally {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* still held */ }
  }
}
