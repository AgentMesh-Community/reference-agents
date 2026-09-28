// The Ring member's part (spec/ring-v1.md). The same file is in every
// TypeScript folder.
//
// A member checks a pass, answers {"ok": true} at once, adds its line and
// hands the story on. Only one thing differs between frameworks: how the line
// is written in live mode. Each folder's agent.mjs passes its own writeLine
// to runMember, and writeLine gets a Gateway to use as its model, so the
// framework never holds a model key.
//
// Settings, all from the environment:
//   RING_HANDLE                 this member's handle (required)
//   AGENTMESH_CREDENTIALS_FILE  the credential bundle join.mjs wrote (on Cloud
//                               Run, the mounted secret), or
//   AGENTMESH_FOLDER            the folder join.mjs wrote
//   RING_RUNNER                 the runner it trusts (ring.demo@agentmesh.ai)
//   RING_GATEWAY                the model gateway (models.platform@agentmesh.ai)
//   PORT                        when set (Cloud Run sets it), answer health checks there
//
// The conformance check sets RING_LOCAL=1, AGENTMESH_SERVERS,
// AGENTMESH_AGENT_SEED and RING_DIRECTORY instead; see tests/ring-check.mjs.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  AgentMesh,
  CredentialRenewer,
  Diagnostics,
  RejectedError,
  canonicalJSON,
  jwtAuthenticator,
  keyPairFromSeed,
  verifyTagged,
} from "agentmesh";

export const ROUTE_TAG = "agentmesh-ring-route-v1\n";
export const DEFAULT_RUNNER = "ring.demo@agentmesh.ai";
export const DEFAULT_GATEWAY = "models.platform@agentmesh.ai";
export const MAX_TOKENS = 120;
const MAX_WORDS = 40;

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

export function routeSignatureOk(route, runnerKey) {
  if (!route || typeof route !== "object" || typeof route.sig !== "string") return false;
  const { sig, ...unsigned } = route;
  let bytes;
  try { bytes = new Uint8Array(Buffer.from(sig.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""), "base64url")); } catch { return false; }
  if (bytes.length !== 64) return false;
  return verifyTagged(runnerKey, ROUTE_TAG, canonicalJSON(unsigned), bytes);
}

export async function checkPass(p, me, runner, sender, keys) {
  if (!p || typeof p !== "object" || p.ring !== "v1" || !p.route || typeof p.route !== "object") {
    throw new RejectedError("route signature invalid: this is not a Ring v1 pass");
  }
  const route = p.route;
  if (String(route.runner ?? "").toLowerCase() !== runner.toLowerCase()) {
    throw new RejectedError("route signature invalid: the route names a runner this member does not trust");
  }
  const runnerKey = await keys.of(runner);
  if (!runnerKey || !routeSignatureOk(route, runnerKey)) throw new RejectedError("route signature invalid");
  const members = route.members;
  const hop = p.hop;
  if (!Array.isArray(members) || !Number.isInteger(hop) || hop < 0 || hop >= members.length) throw new RejectedError("wrong hop");
  if (String(members[hop]).toLowerCase() !== me.toLowerCase()) throw new RejectedError("wrong hop");
  const expected = hop === 0 ? runner : String(members[hop - 1]);
  if ((await keys.of(expected)) !== sender) throw new RejectedError("wrong sender");
}

// ── the model gateway ───────────────────────────────────────────────────────

/** The member's only way to a model: a model.complete request to the gateway.
 *  Token counts add up across calls for one line. */
export class Gateway {
  constructor(mesh, to, lapId, model) {
    Object.assign(this, { mesh, to, lapId, model, tokensIn: 0, tokensOut: 0, calls: 0 });
  }
  async complete(messages, maxTokens = MAX_TOKENS) {
    const r = await this.mesh.request(this.to, "model.complete",
      { lap_id: this.lapId, model: this.model, messages, max_tokens: maxTokens }, { timeout_ms: 120_000 });
    const out = r.payload?.output;
    if (r.payload?.status !== "completed" || typeof out?.text !== "string") {
      throw new Error(`the gateway answered ${r.payload?.status}: ${JSON.stringify(r.payload).slice(0, 300)}`);
    }
    this.calls += 1;
    this.tokensIn += Number(out.tokens_in) || 0;
    this.tokensOut += Number(out.tokens_out) || 0;
    return out.text;
  }
}

export function prompts(framework, opening, story) {
  const system = `You are ${framework}, one of several AI agents writing a story together, one sentence each. `
    + "Continue the story with exactly one new sentence in your own voice, at most 30 words. "
    + "Reply with the sentence only: no quotes, no title, no explanation.";
  const lines = [opening, ...story.map((e) => String(e?.line ?? ""))].filter(Boolean);
  const user = `The story so far:\n${lines.map((l) => `- ${l}`).join("\n")}\n\nWrite the next sentence.`;
  return { system, user };
}

export function tidy(text) {
  let t = String(text ?? "").trim().split(/\s+/).join(" ");
  t = t.replace(/^["“]+|["”]+$/g, "").trim();
  const words = t.split(" ");
  if (words.length > MAX_WORDS) t = `${words.slice(0, MAX_WORDS).join(" ").replace(/[,;:]$/, "")}...`;
  return t;
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
  if (process.env.RING_LOCAL === "1") {
    return AgentMesh.connect(pickServers(String(process.env.AGENTMESH_SERVERS).split(",").filter(Boolean)), { nkeySeed: process.env.AGENTMESH_AGENT_SEED, requireNamed: false, fenceInbound: false });
  }
  const c = await loadCredentials();
  const agentId = keyPairFromSeed(c.agentSeed).getPublicKey();
  // The credential is renewed at every start, so it carries what the mesh
  // grants today (the durable feed consumer the pub/sub rounds need came after
  // some credentials were minted). Renewal proves the keys over HTTPS and needs
  // no live connection. A failed renewal falls back to the saved credential
  // while it is still good.
  const renewer = new CredentialRenewer({ apiBase: c.apiBase, jwt: c.jwt, nodeSeed: c.seed, agents: [{ id: agentId, seed: c.agentSeed }] });
  try {
    c.jwt = (await renewer.renew()).jwt;
    log("credential renewed at start");
  } catch (err) {
    if (renewer.status().expired) throw err;
    log(`credential not renewed at start (${err?.message ?? err}); using the saved one`);
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

// ── the member ──────────────────────────────────────────────────────────────

/**
 * Run a Ring member. `writeLine({ framework, handle, opening, story, gateway,
 * system, user })` returns the line in live mode; it is never called in fixed
 * mode.
 */
/** Whether a gateway model id matches a declaration ("*" is any; "anthropic/*" a prefix). */
export function canUse(model, liveModels) {
  const m = String(model).trim().toLowerCase();
  return liveModels.some((pat) => {
    const p = String(pat).trim().toLowerCase();
    return p === "*" || p === m || (p.endsWith("*") && m.startsWith(p.slice(0, -1)));
  });
}

/** The tag that says this member answers pub/sub rounds (role ring-member v2). */
export const PUBSUB_TAG = "ring-pubsub";

/** The declaration as the ring.pass offering's tags on the card (spec section 7),
 *  and the pub/sub tag (spec section 9). */
export const passTags = (liveModels, via) => [`ring-via:${via}`, ...liveModels.map((m) => `ring-model:${m}`), PUBSUB_TAG];

/** The runner's round feed (spec section 9): mesh.feed.<runner key>.ring-round. */
export const ROUND_TOPIC = "ring-round";
/** A round older than this is not answered: the runner takes no line for it. */
const ROUND_LATE_WINDOW_MS = 60 * 60_000;

export const RING_PAGE = "https://agentmesh.ai/ring.html";

/** File this agent's Agent Descriptor at the registry, signed by its own key.
 *  The registry keeps it, and the AgentMesh AgentDoc for this agent is
 *  assembled from it. Best effort: the member works the same without it. */
async function fileDescriptor(mesh, handle, does, offerings) {
  const body = {
    format: "agent-descriptor-v1",
    agent_version: "1.0.0",
    subject: { id: mesh.id, handle },
    does,
    interaction: "service",
    role: "ring-member",
    offerings: offerings.map((o) => ({ id: o.id, name: o.name, does: o.description })),
    refusals: "Refuses a pass whose route the runner did not sign, one that is not its turn, and one from anybody but the member before it on the route.",
  };
  const sig = mesh.signDetached(`descriptor-statement-v1\n${canonicalJSON(body)}`);
  const doc = { ...body, signatures: [{ tag: "descriptor-statement-v1", by: mesh.id, sig }] };
  try {
    await mesh.serviceRequest("mesh.registry.descriptor.put", { descriptor: Buffer.from(JSON.stringify(doc)).toString("base64") }, 10_000);
    log("descriptor filed at the registry");
  } catch (err) {
    log(`descriptor not filed (${err?.message ?? err}); the member works the same without it`);
  }
}

/** `liveModels` and `via` are the declaration (spec section 7): the model ids
 *  this member can write with in live mode (["*"] is any model the gateway
 *  serves, ["none"] sits out every live lap), and whether its words come
 *  through the gateway or from a harness with a model of its own. `source`
 *  is where its code is, for its listing. */
export async function runMember({ framework, writeLine, description, liveModels = ["*"], via = "gateway", source = "" }) {
  const listed = `${description}${source ? ` Source: ${source}.` : ""} Watch the laps: ${RING_PAGE}.`;
  const handle = String(process.env.RING_HANDLE ?? "").trim().toLowerCase();
  if (!handle) throw new Error("Set RING_HANDLE to this member's handle, for example mastra.demo@agentmesh.ai.");
  const runner = String(process.env.RING_RUNNER ?? DEFAULT_RUNNER).trim().toLowerCase();
  const gatewayHandle = String(process.env.RING_GATEWAY ?? DEFAULT_GATEWAY).trim().toLowerCase();
  const local = process.env.RING_LOCAL === "1";

  if (process.env.PORT) {
    createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ring member\n"); })
      .listen(Number(process.env.PORT), "0.0.0.0", () => log(`health checks answered on port ${process.env.PORT}`));
  }
  // When this process started: a round published before it is one this
  // member missed while it was not running, and its answer says late.
  const startedAt = Date.now();
  const mesh = await connectMesh();
  const keys = new Keys(mesh, local ? process.env.RING_DIRECTORY : null);
  const seen = new Map();

  /** This member's line for a lap: one sentence through the gateway (or its
   *  harness) in a live lap, `fixedLine` in a fixed one. */
  async function makeLine(lap, lapId, story, fixedLine) {
    const t0 = Date.now();
    let line;
    let tokensIn = 0;
    let tokensOut = 0;
    const model = String(lap.model ?? "");
    if (lap.mode === "live" && !canUse(model, liveModels)) {
      // A runner routes a member only into laps on models it declared; if one
      // arrives anyway, the story still goes on.
      line = `(${framework} cannot write with ${model} and passes the story on)`;
    } else if (lap.mode === "live") {
      const gateway = new Gateway(mesh, (await keys.of(gatewayHandle)) ?? gatewayHandle, String(lapId), model);
      const { system, user } = prompts(framework, String(lap.opening ?? ""), story);
      tokensIn = null;
      try {
        // writeLine answers the line, or { text, tokens_in, tokens_out } when
        // its words did not come through the gateway (a harness with a model
        // of its own) and it counts its own tokens.
        const r = await writeLine({ framework, handle, model, opening: String(lap.opening ?? ""), story, gateway, system, user });
        line = tidy(typeof r === "string" ? r : r?.text);
        if (r && typeof r === "object") { tokensIn = Number(r.tokens_in) || 0; tokensOut = Number(r.tokens_out) || 0; }
      } catch (err) {
        log(`lap ${lapId}: the line could not be written: ${err?.message ?? err}`);
        line = `(${framework} could not write a line: ${String(err?.message ?? err).slice(0, 120)})`;
      }
      if (tokensIn === null) { tokensIn = gateway.tokensIn; tokensOut = gateway.tokensOut; }
    } else {
      line = fixedLine;
    }
    return { line, ms: Date.now() - t0, tokensIn, tokensOut };
  }

  // ── pub/sub rounds (spec section 9, role ring-member v2) ──
  const answered = new Map();

  async function answerRound(payload, env, runnerKey) {
    // Only the runner's own signed round: the SDK has verified the signature
    // against env.from, and env.from must be the key the runner's name resolves to.
    if (env?.from !== runnerKey) return;
    const d = payload?.data;
    if (!d || typeof d !== "object" || d.ring !== "v1" || d.mode !== "pubsub" || typeof d.lap_id !== "string" || !Number.isInteger(d.round)) return;
    const lap = d.lap && typeof d.lap === "object" ? d.lap : {};
    const key = `${d.lap_id}|${d.round}`;
    if (answered.has(key)) return; // each lap once
    answered.set(key, Date.now());
    for (const [k, at] of answered) if (Date.now() - at > 2 * ROUND_LATE_WINDOW_MS) answered.delete(k);
    const published = Date.parse(env.ts ?? lap.started_at ?? "");
    if (Number.isFinite(published) && Date.now() - published > ROUND_LATE_WINDOW_MS) {
      log(`lap ${d.lap_id}: round published over an hour ago; not answered`);
      return;
    }
    if (lap.mode === "live" && !canUse(String(lap.model ?? ""), liveModels)) {
      log(`lap ${d.lap_id}: sits out the pub/sub round (cannot write with ${lap.model})`);
      return;
    }
    const late = Number.isFinite(published) && published < startedAt;
    const { line, ms, tokensIn, tokensOut } = await makeLine(lap, d.lap_id, [], `${framework}:pubsub`);
    const answer = { lap_id: d.lap_id, round: d.round, by: handle, framework, line, at: nowIso(), ms, tokens_in: tokensIn, tokens_out: tokensOut, late };
    for (const attempt of [1, 2, 3]) {
      try {
        const r = await mesh.request(runnerKey, "ring.line", answer, { timeout_ms: 30_000 });
        const out = r.payload?.output;
        log(`lap ${d.lap_id}: ring.line sent${late ? " (late)" : ""}; the runner said ${JSON.stringify(out ?? r.payload?.status).slice(0, 160)}`);
        return;
      } catch (err) {
        log(`lap ${d.lap_id}: ring.line failed (try ${attempt}): ${err?.message ?? err}`);
        await sleep(3000 * attempt);
      }
    }
  }

  /** Follow the runner's round feed, durably when the mesh allows it, so a
   *  round published while this member was stopped is answered on its return. */
  async function followRounds() {
    const runnerKey = await keys.of(runner);
    if (!runnerKey) {
      log(`${runner} does not resolve yet; following pub/sub rounds is tried again in a minute`);
      setTimeout(() => { followRounds().catch((err) => log(`pub/sub rounds: ${err?.message ?? err}`)); }, 60_000);
      return;
    }
    const onRound = (payload, env) => {
      answerRound(payload, env, runnerKey).catch((err) => log(`a pub/sub round could not be answered: ${err?.message ?? err}`));
    };
    try {
      const sub = await mesh.subscribeFeed(runnerKey, ROUND_TOPIC, onRound, { durable: true });
      log(`following pub/sub rounds durably on ${sub.subject} (consumer ${sub.durable})`);
    } catch (err) {
      mesh.subscribeFeed(runnerKey, ROUND_TOPIC, onRound);
      log(`following pub/sub rounds live only, so a round sent while this member is stopped is missed: ${err?.message ?? err}`);
    }
  }

  async function carryOn(p) {
    const lap = p.lap && typeof p.lap === "object" ? p.lap : {};
    const { route, hop } = p;
    const story = (Array.isArray(p.story) ? p.story : []).filter((e) => e && typeof e === "object");
    const { line, ms, tokensIn, tokensOut } = await makeLine(lap, p.lap_id, story, `${framework}:${hop}`);
    const entry = { by: handle, framework, line, at: nowIso(), ms, tokens_in: tokensIn, tokens_out: tokensOut };
    const next = { ...p, story: [...story, entry] };
    let target = runner;
    let offering = "ring.done";
    if (hop + 1 < route.members.length) {
      target = String(route.members[hop + 1]);
      offering = "ring.pass";
      next.hop = hop + 1;
    }
    for (const attempt of [1, 2, 3]) {
      try {
        const to = await keys.of(target);
        if (!to) throw new Error(`${target} does not resolve`);
        await mesh.request(to, offering, next, { timeout_ms: 30_000 });
        log(`lap ${p.lap_id} hop ${hop}: ${offering} sent to ${target}`);
        return;
      } catch (err) {
        log(`lap ${p.lap_id} hop ${hop}: ${offering} to ${target} failed (try ${attempt}): ${err?.message ?? err}`);
        await sleep(3000 * attempt);
      }
    }
  }

  mesh.onRequest("ring.pass", async (p, ctx) => {
    try {
      await checkPass(p, handle, runner, ctx.envelope.from, keys);
    } catch (err) {
      log(`refused a pass from ${String(ctx.envelope.from).slice(0, 12)}...: ${err?.message ?? err}`);
      throw err;
    }
    const key = `${p.lap_id}|${p.hop}`;
    if (seen.has(key)) return { ok: true };
    seen.set(key, Date.now());
    for (const [k, at] of seen) if (Date.now() - at > 3_600_000) seen.delete(k);
    setImmediate(() => { carryOn(p).catch((err) => log(`lap ${p.lap_id}: ${err?.message ?? err}`)); });
    return { ok: true };
  });

  const tags = passTags(liveModels, via);
  mesh.onRequest("ring.about", () => ({ ring: "v1", role: "ring-member", role_version: 2, transports: ["point-to-point", "pubsub"], handle, framework, via, live_models: liveModels, tags }));

  const offerings = [
    { id: "ring.pass", name: "Ring pass", tags, description: "Takes a Ring v1 pass, adds one line to the story and hands it on; also answers the runner's pub/sub rounds with ring.line (role ring-member v2)." },
    { id: "ring.about", name: "Ring member facts", description: "Says which framework this member is and which models it can write with in live laps." },
  ];
  await followRounds();
  await mesh.register({
    name: handle.split(".")[0],
    description: listed,
    offerings,
    // Public, so the runner can find this member's key in the registry.
    visibility: "public",
    meta: { framework, roles: ["ring-member@1", "ring-member@2"] },
  });
  log(`ring member ready: ${handle} (${framework}) as ${mesh.id}`);
  if (!local) void fileDescriptor(mesh, handle, listed, offerings);

  const stop = async () => { await mesh.close().catch(() => {}); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
