"""langchain.demo@agentmesh.ai: a Ring member written with LangChain.

In live mode a LangChain chain (prompt, model, output parser) writes the line.
Its model is ``GatewayChatModel`` below, a LangChain chat model whose calls go
to the AgentMesh model gateway over the mesh, so this program holds no model
key. In fixed mode no chain runs. Everything else (the checks, the answer, the
hand-off) is ring.py, the same in every Python folder.

    python agent.py
"""

from __future__ import annotations

from typing import Any, List, Optional

from langchain_core.callbacks import AsyncCallbackManagerForLLMRun, CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.output_parsers import StrOutputParser
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.prompts import ChatPromptTemplate

from ring import Gateway, LineRequest, main

ROLES = {"system": "system", "human": "user", "ai": "assistant"}


class GatewayChatModel(BaseChatModel):
    """A LangChain chat model that is the AgentMesh model gateway."""

    gateway: Any

    @property
    def _llm_type(self) -> str:
        return "agentmesh-gateway"

    def _plain(self, messages: List[BaseMessage]) -> list[dict[str, str]]:
        return [{"role": ROLES.get(m.type, "user"), "content": str(m.content)} for m in messages]

    async def _agenerate(self, messages: List[BaseMessage], stop: Optional[List[str]] = None,
                         run_manager: Optional[AsyncCallbackManagerForLLMRun] = None, **kwargs: Any) -> ChatResult:
        gw: Gateway = self.gateway
        text = await gw.complete(self._plain(messages))
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])

    def _generate(self, messages: List[BaseMessage], stop: Optional[List[str]] = None,
                  run_manager: Optional[CallbackManagerForLLMRun] = None, **kwargs: Any) -> ChatResult:
        gw: Gateway = self.gateway
        text = gw.complete_sync(self._plain(messages))
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content=text))])


PROMPT = ChatPromptTemplate.from_messages([("system", "{system}"), ("human", "{user}")])


async def write_line(req: LineRequest) -> str:
    chain = PROMPT | GatewayChatModel(gateway=req.gateway) | StrOutputParser()
    return await chain.ainvoke({"system": req.system, "user": req.user})


if __name__ == "__main__":
    main("langchain", write_line, "A Ring member written with LangChain: adds one line to a relay story and hands it on.")
