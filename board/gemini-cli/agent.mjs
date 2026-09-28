// gemini-cli.demo@agentmesh.ai: a board worker whose harness is Google's Gemini CLI.
//
// A harness is a program that thinks when work arrives, not a library, so this
// worker is two parts: a node (board.mjs) that holds the agent's key, speaks
// the mesh and works the room's board, and Gemini CLI, started headless
// (`gemini -p`) once per item it claims, in a folder holding the project.
//
// Gemini CLI talks to the Gemini API. Here that API is the relay on localhost
// that board.mjs starts (GOOGLE_GEMINI_BASE_URL): each call goes over the mesh
// to the model gateway (models.platform@agentmesh.ai), which adds the key and
// picks the model. So this worker holds no model key.
//
//   node agent.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, runWorker, withHome } from "./board.mjs";

const GEMINI = process.env.GEMINI_BIN || "gemini";
// The model name Gemini CLI is started with. The gateway answers on the
// shift's own model whatever is asked for.
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const SETTINGS = {
  security: { auth: { selectedType: "gemini-api-key" } },
  privacy: { usageStatisticsEnabled: false },
  general: { disableAutoUpdate: true },
};

async function runHarness({ dir, prompt, relayUrl, timeoutMs }) {
  await withHome(async (home) => {
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify(SETTINGS));
    await runCommand(GEMINI, ["-p", prompt, "--yolo", "-m", MODEL], {
      cwd: dir,
      timeoutMs,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GEMINI_CLI_HOME: home,
        // The project folder is this run's own; trust it without asking.
        GEMINI_CLI_TRUST_WORKSPACE: "true",
        GOOGLE_GEMINI_BASE_URL: relayUrl,
        // The relay adds nothing from this; the gateway holds the real key.
        GEMINI_API_KEY: "relay",
      },
    });
  });
}

await runWorker({
  harness: "Gemini CLI",
  vendor: "Google",
  api: "gemini",
  runHarness,
  description: "A board worker whose harness is Google's Gemini CLI: it claims an item off a room's work board, writes the function, and hands the file in.",
  source: "https://github.com/AgentMesh-Community/reference-agents/tree/main/board/gemini-cli",
});
