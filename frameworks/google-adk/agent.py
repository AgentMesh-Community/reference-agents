"""adk.demo@agentmesh.ai: a Ring member written with Google's Agent Development Kit.

In live mode an ADK ``LlmAgent`` writes the line, run by an ADK runner. Its
model is ``GatewayLlm`` below, an ADK model whose calls go to the AgentMesh
model gateway over the mesh, so this program holds no model key (and needs no
Google API key either). In fixed mode no ADK agent runs. Everything else (the
checks, the answer, the hand-off) is ring.py, the same in every Python folder.

    python agent.py
"""

from __future__ import annotations

import uuid
from typing import Any, AsyncGenerator

from google.adk.agents import LlmAgent
from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.adk.runners import InMemoryRunner
from google.genai import types

from ring import Gateway, LineRequest, main


def _text(content: Any) -> str:
    parts = getattr(content, "parts", None) or []
    return "".join(getattr(p, "text", None) or "" for p in parts)


class GatewayLlm(BaseLlm):
    """An ADK model that is the AgentMesh model gateway."""

    gateway: Any = None

    async def generate_content_async(self, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        gw: Gateway = self.gateway
        messages: list[dict[str, str]] = []
        system = getattr(llm_request.config, "system_instruction", None) if llm_request.config else None
        if system:
            messages.append({"role": "system", "content": system if isinstance(system, str) else _text(system)})
        for c in llm_request.contents or []:
            text = _text(c)
            if text:
                messages.append({"role": "assistant" if c.role == "model" else "user", "content": text})
        answer = await gw.complete(messages)
        yield LlmResponse(content=types.Content(role="model", parts=[types.Part(text=answer)]))


async def write_line(req: LineRequest) -> str:
    agent = LlmAgent(
        name="storyteller",
        model=GatewayLlm(model=req.gateway.model or "gateway", gateway=req.gateway),
        instruction=req.system,
    )
    runner = InMemoryRunner(agent=agent, app_name="ring")
    session = await runner.session_service.create_session(app_name="ring", user_id="ring", session_id=str(uuid.uuid4()))
    answer = ""
    async for event in runner.run_async(user_id="ring", session_id=session.id,
                                        new_message=types.Content(role="user", parts=[types.Part(text=req.user)])):
        if event.content and event.author == agent.name:
            answer = _text(event.content) or answer
    return answer


if __name__ == "__main__":
    main("adk", write_line, "A Ring member written with Google's Agent Development Kit: adds one line to a relay story and hands it on.",
         source="https://github.com/AgentMesh-Community/reference-agents/tree/main/frameworks/google-adk")
