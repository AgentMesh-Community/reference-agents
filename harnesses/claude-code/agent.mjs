// claude-code.demo@agentmesh.ai: a Ring member whose harness is Claude Code.
//
// Claude Code is a harness, not a library, so this member is two parts, the
// way every harness agent on AgentMesh is: a node that holds the agent's key
// and speaks the mesh (ring.mjs, the same file as in the TypeScript folders),
// and the harness, started once per message that needs it. The node checks
// each pass, answers at once and hands the story on; Claude Code is started
// only to write a line in a live lap.
//
// Claude Code runs on its own model, Anthropic's, not through the AgentMesh
// model gateway. So this member declares Anthropic models only, and only when
// it has Anthropic access (ANTHROPIC_API_KEY). A runner leaves it out of laps
// on any other model: it sits them out. In fixed mode Claude Code is never
// started and no key is needed.
//
//   node agent.mjs

import { spawn } from "node:child_process";
import { runMember } from "./ring.mjs";

const CLAUDE = process.env.CLAUDE_BIN || "claude";
const TIMEOUT_MS = 120_000;
const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;

/** "anthropic/claude-sonnet-4-6" is the gateway's name; Claude Code takes "claude-sonnet-4-6". */
const claudeModel = (model) => String(model).replace(/^anthropic\//i, "");

function runClaude(args, input) {
  return new Promise((resolve, reject) => {
    // --bare: no hooks, plugins, memory or CLAUDE.md, and the key from
    // ANTHROPIC_API_KEY only. --tools "": a line of a story needs no tools.
    const child = spawn(CLAUDE, args, { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`claude did not answer within ${TIMEOUT_MS / 1000}s`)); }, TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    child.on("error", (e) => { clearTimeout(timer); reject(new Error(`claude could not start: ${e.message}`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().split("\n").pop() ?? ""}`));
      resolve(out);
    });
    child.stdin.end(input);
  });
}

async function writeLine({ model, system, user }) {
  const out = await runClaude([
    "-p", "--bare", "--tools", "", "--no-session-persistence",
    "--output-format", "json",
    "--model", claudeModel(model),
    "--system-prompt", system,
  ], user);
  const r = JSON.parse(out);
  if (r.is_error) throw new Error(String(r.result ?? "claude reported an error"));
  const u = r.usage ?? {};
  return {
    text: String(r.result ?? ""),
    tokens_in: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
    tokens_out: u.output_tokens ?? 0,
  };
}

await runMember({
  framework: "claude-code",
  writeLine,
  via: "harness",
  // Without Anthropic access it can write with no model: "none" says so on
  // its card, and a runner leaves it out of every live lap.
  liveModels: hasAnthropic ? ["anthropic/*"] : ["none"],
  description: "A Ring member whose harness is Claude Code: adds one line to a relay story and hands it on.",
  source: "https://github.com/AgentMesh-Community/reference-agents/tree/main/harnesses/claude-code",
});
