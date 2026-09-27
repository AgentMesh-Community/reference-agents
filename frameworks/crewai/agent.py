"""crewai.demo@agentmesh.ai: a Ring member written with CrewAI.

In live mode a one-agent crew writes the line. Its model is the AgentMesh model
gateway, reached over the mesh through ``GatewayLLM`` below, so this program
holds no model key. In fixed mode no crew runs at all. Everything else (the
checks, the answer, the hand-off) is ring.py, the same in every Python folder.

    python agent.py
"""

from __future__ import annotations

import asyncio
from typing import Any

from crewai import Agent, BaseLLM, Crew, Task

from ring import Gateway, LineRequest, main


class GatewayLLM(BaseLLM):
    """A CrewAI model that is the AgentMesh model gateway.

    CrewAI calls ``call`` from a worker thread, so it reaches the mesh with
    ``Gateway.complete_sync``.
    """

    def __init__(self, gateway: Gateway):
        super().__init__(model=gateway.model or "gateway", temperature=None)
        self._gateway = gateway

    def call(self, messages: Any, tools: Any = None, callbacks: Any = None, available_functions: Any = None, **_: Any) -> str:
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        plain = [{"role": str(m.get("role", "user")), "content": str(m.get("content", ""))} for m in messages]
        return self._gateway.complete_sync(plain)

    def supports_function_calling(self) -> bool:
        return False

    def supports_stop_words(self) -> bool:
        return False

    def get_context_window_size(self) -> int:
        return 8192


def run_crew(req: LineRequest) -> str:
    storyteller = Agent(
        role="Storyteller",
        goal="Add one sentence to a story that several agents are writing together.",
        backstory=req.system,
        llm=GatewayLLM(req.gateway),
        allow_delegation=False,
        verbose=False,
        max_iter=1,
    )
    task = Task(
        description=req.user,
        expected_output="One sentence of at most 30 words, and nothing else.",
        agent=storyteller,
    )
    result = Crew(agents=[storyteller], tasks=[task], verbose=False).kickoff()
    return str(getattr(result, "raw", result))


async def write_line(req: LineRequest) -> str:
    # A crew runs synchronously; run it beside the mesh connection, not on it.
    return await asyncio.to_thread(run_crew, req)


if __name__ == "__main__":
    main("crewai", write_line, "A Ring member written with CrewAI: adds one line to a relay story and hands it on.",
         source="https://github.com/AgentMesh-Community/reference-agents/tree/main/frameworks/crewai")
