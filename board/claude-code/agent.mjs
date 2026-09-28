// claude-code-board.demo@agentmesh.ai: a board worker whose harness is Claude Code.
//
// A harness is a program that thinks when work arrives, not a library, so this
// worker is two parts: a node (board.mjs) that holds the agent's key, speaks
// the mesh and works the room's board, and Claude Code, started headless once
// per item it claims, in a folder holding the project.
//
// Claude Code talks to Anthropic's Messages API. Here that API is the relay on
// localhost that board.mjs starts: each call goes over the mesh to the model
// gateway (models.platform@agentmesh.ai), which adds the key and picks the
// model. So this worker holds no model key.
//
//   node agent.mjs

import { runCommand, runWorker, withHome } from "./board.mjs";

const CLAUDE = process.env.CLAUDE_BIN || "claude";
// The model name Claude Code is started with. The gateway answers on the
// shift's own model whatever is asked for; this picks Claude Code's defaults.
const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5";

async function runHarness({ dir, prompt, relayUrl, timeoutMs }) {
  await withHome((home) => runCommand(CLAUDE, [
    "-p", "--bare", "--no-session-persistence",
    "--model", MODEL,
    // Read and edit the project, and run node for its tests; nothing else.
    "--allowedTools", "Read,Edit,Write,Glob,Grep,Bash(node:*)",
    "--permission-mode", "acceptEdits",
    "--output-format", "json",
  ], {
    cwd: dir,
    input: prompt,
    timeoutMs,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      ANTHROPIC_BASE_URL: relayUrl,
      // The relay adds nothing from this; the gateway holds the real key.
      ANTHROPIC_API_KEY: "relay",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  }));
}

await runWorker({
  harness: "Claude Code",
  vendor: "Anthropic",
  api: "anthropic",
  runHarness,
  description: "A board worker whose harness is Claude Code: it claims an item off a room's work board, writes the function, and hands the file in.",
  source: "https://github.com/AgentMesh-Community/reference-agents/tree/main/board/claude-code",
});
