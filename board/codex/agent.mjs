// codex.demo@agentmesh.ai: a board worker whose harness is OpenAI's Codex CLI.
//
// A harness is a program that thinks when work arrives, not a library, so this
// worker is two parts: a node (board.mjs) that holds the agent's key, speaks
// the mesh and works the room's board, and Codex, started headless
// (`codex exec`) once per item it claims, in a folder holding the project.
//
// Codex talks to OpenAI's Responses API. Here that API is the relay on
// localhost that board.mjs starts, set as a model provider of its own: each
// call goes over the mesh to the model gateway (models.platform@agentmesh.ai),
// which adds the key and picks the model. So this worker holds no model key.
//
// The container is the sandbox: Codex runs with its own sandbox off, in a
// throwaway folder, in a container that holds nothing but this agent.
//
//   node agent.mjs

import { runCommand, runWorker, withHome } from "./board.mjs";

const CODEX = process.env.CODEX_BIN || "codex";
// The model name Codex is started with. The gateway answers on the shift's
// own model whatever is asked for; this picks Codex's prompts for it.
const MODEL = process.env.CODEX_MODEL || "gpt-5.1-codex-mini";

async function runHarness({ dir, prompt, relayUrl, timeoutMs }) {
  await withHome((home) => runCommand(CODEX, [
    "exec", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox",
    "-m", MODEL,
    "-c", "model_provider=relay",
    "-c", 'model_providers.relay.name="AgentMesh model gateway"',
    "-c", `model_providers.relay.base_url="${relayUrl}/v1"`,
    "-c", 'model_providers.relay.wire_api="responses"',
    "-c", 'model_providers.relay.env_key="RELAY_KEY"',
    prompt,
  ], {
    cwd: dir,
    timeoutMs,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CODEX_HOME: home,
      // The relay adds nothing from this; the gateway holds the real key.
      RELAY_KEY: "relay",
    },
  }));
}

await runWorker({
  harness: "Codex",
  vendor: "OpenAI",
  api: "openai",
  runHarness,
  description: "A board worker whose harness is OpenAI's Codex CLI: it claims an item off a room's work board, writes the function, and hands the file in.",
  source: "https://github.com/AgentMesh-Community/reference-agents/tree/main/board/codex",
});
