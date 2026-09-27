// mastra.demo@agentmesh.ai: a Ring member written with Mastra.
//
// In live mode a Mastra Agent writes the line. Its model is gatewayModel()
// below, a language model (the AI SDK's model interface, which Mastra takes
// directly) whose calls go to the AgentMesh model gateway over the mesh, so
// this program holds no model key. In fixed mode no Mastra agent runs.
// Everything else (the checks, the answer, the hand-off) is ring.mjs, the
// same in every TypeScript folder.
//
//   node agent.mjs

import { Agent } from "@mastra/core/agent";
import { runMember } from "./ring.mjs";

/** The prompt Mastra hands a model, as the plain messages the gateway takes. */
function plainMessages(prompt) {
  return prompt.map((m) => ({
    role: m.role === "tool" ? "user" : m.role,
    content: typeof m.content === "string"
      ? m.content
      : (m.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join(""),
  })).filter((m) => m.content);
}

/** A language model that is the AgentMesh model gateway. */
function gatewayModel(gateway) {
  const generate = async (options) => {
    const before = { tin: gateway.tokensIn, tout: gateway.tokensOut };
    const text = await gateway.complete(plainMessages(options.prompt), options.maxOutputTokens ?? undefined);
    const usage = { inputTokens: gateway.tokensIn - before.tin, outputTokens: gateway.tokensOut - before.tout };
    usage.totalTokens = usage.inputTokens + usage.outputTokens;
    return { text, usage };
  };
  return {
    specificationVersion: "v2",
    provider: "agentmesh-gateway",
    modelId: gateway.model || "gateway",
    supportedUrls: {},
    async doGenerate(options) {
      const { text, usage } = await generate(options);
      return { content: [{ type: "text", text }], finishReason: "stop", usage, warnings: [] };
    },
    async doStream(options) {
      const { text, usage } = await generate(options);
      const stream = new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "t0" });
          c.enqueue({ type: "text-delta", id: "t0", delta: text });
          c.enqueue({ type: "text-end", id: "t0" });
          c.enqueue({ type: "finish", finishReason: "stop", usage });
          c.close();
        },
      });
      return { stream };
    },
  };
}

async function writeLine({ gateway, system, user }) {
  const storyteller = new Agent({
    name: "storyteller",
    instructions: system,
    model: gatewayModel(gateway),
  });
  const result = await storyteller.generate(user);
  return result.text;
}

await runMember({
  framework: "mastra",
  writeLine,
  description: "A Ring member written with Mastra: adds one line to a relay story and hands it on.",
});
