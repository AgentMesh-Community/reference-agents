"""The Ring member's part (spec/ring-v1.md). The same file is in every Python folder.

A member checks a pass, answers {"ok": true} at once, adds its line and hands
the story on. Only one thing differs between frameworks: how the line is
written in live mode. Each folder's agent.py passes its own ``write_line`` to
``run_member``, and ``write_line`` gets a ``Gateway`` to use as its model, so
the framework never holds a model key.

Settings, all from the environment:

    RING_HANDLE                 this member's handle (required)
    AGENTMESH_CREDENTIALS_FILE  the credential bundle join.py wrote (on Cloud Run,
                                the mounted secret), or
    AGENTMESH_FOLDER            the folder join.py wrote
    RING_RUNNER                 the runner it trusts (ring.demo@agentmesh.ai)
    RING_GATEWAY                the model gateway (models.platform@agentmesh.ai)
    PORT                        when set (Cloud Run sets it), answer health checks there

The conformance check sets RING_LOCAL=1, AGENTMESH_SERVERS, AGENTMESH_AGENT_SEED
and RING_DIRECTORY instead of credentials; see tests/ring-check.mjs.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

from agentmesh import Credentials, RejectedError, connect
from agentmesh.canonical import canonical_json
from agentmesh.keys import b64url_decode, verify_signature

ROUTE_TAG = "agentmesh-ring-route-v1\n"
DEFAULT_RUNNER = "ring.demo@agentmesh.ai"
DEFAULT_GATEWAY = "models.platform@agentmesh.ai"
MAX_TOKENS = 120
MAX_WORDS = 40


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def log(msg: str) -> None:
    print(f"{now_iso()} {msg}", flush=True)


# ── who is who ──────────────────────────────────────────────────────────────


class Keys:
    """A handle's agent key: from the naming service, or from the test's directory file."""

    def __init__(self, mesh: Any, directory: str | None):
        self.mesh = mesh
        self.fixed: dict[str, str] | None = None
        if directory:
            self.fixed = {k.lower(): v for k, v in json.loads(Path(directory).read_text(encoding="utf-8")).items()}
        self.cache: dict[str, tuple[str, float]] = {}

    async def of(self, handle: str) -> str | None:
        h = handle.strip().lower()
        if self.fixed is not None:
            return self.fixed.get(h)
        hit = self.cache.get(h)
        if hit and time.monotonic() - hit[1] < 600:
            return hit[0]
        card = await self.mesh.resolve(h)
        key = card.agent_id if card is not None else None
        if key:
            self.cache[h] = (key, time.monotonic())
        return key


def route_signature_ok(route: Any, runner_key: str) -> bool:
    if not isinstance(route, dict) or not isinstance(route.get("sig"), str):
        return False
    unsigned = {k: v for k, v in route.items() if k != "sig"}
    try:
        sig = b64url_decode(route["sig"].replace("+", "-").replace("/", "_").rstrip("="))
    except Exception:
        return False
    return verify_signature(runner_key, (ROUTE_TAG + canonical_json(unsigned)).encode("utf-8"), sig)


async def check_pass(p: Any, me: str, runner: str, sender: str, keys: Keys) -> None:
    """Refuse a pass that is not signed by the runner, not ours, or not from the right sender."""
    if not isinstance(p, dict) or p.get("ring") != "v1" or not isinstance(p.get("route"), dict):
        raise RejectedError("route signature invalid: this is not a Ring v1 pass")
    route = p["route"]
    if str(route.get("runner", "")).lower() != runner.lower():
        raise RejectedError("route signature invalid: the route names a runner this member does not trust")
    runner_key = await keys.of(runner)
    if not runner_key or not route_signature_ok(route, runner_key):
        raise RejectedError("route signature invalid")
    members = route.get("members")
    hop = p.get("hop")
    if not isinstance(members, list) or not isinstance(hop, int) or isinstance(hop, bool) or not 0 <= hop < len(members):
        raise RejectedError("wrong hop")
    if str(members[hop]).lower() != me.lower():
        raise RejectedError("wrong hop")
    expected = runner if hop == 0 else str(members[hop - 1])
    if await keys.of(expected) != sender:
        raise RejectedError("wrong sender")


# ── the model gateway ───────────────────────────────────────────────────────


@dataclass
class Gateway:
    """The member's only way to a model: a model.complete request to the gateway.

    A framework uses ``complete`` (async) or ``complete_sync`` (from a worker
    thread) as its model. Token counts add up across calls for one line.
    """

    mesh: Any
    to: str
    lap_id: str
    model: str
    loop: asyncio.AbstractEventLoop
    tokens_in: int = 0
    tokens_out: int = 0
    calls: int = 0

    async def complete(self, messages: list[dict[str, str]], max_tokens: int = MAX_TOKENS) -> str:
        r = await self.mesh.request(
            self.to,
            "model.complete",
            {"lap_id": self.lap_id, "model": self.model, "messages": messages, "max_tokens": max_tokens},
            timeout=120.0,
        )
        out = r.output if isinstance(r.output, dict) else {}
        if r.status != "completed" or not isinstance(out.get("text"), str):
            raise RuntimeError(f"the gateway answered {r.status}: {json.dumps(r.payload)[:300]}")
        self.calls += 1
        self.tokens_in += int(out.get("tokens_in") or 0)
        self.tokens_out += int(out.get("tokens_out") or 0)
        return out["text"]

    def complete_sync(self, messages: list[dict[str, str]], max_tokens: int = MAX_TOKENS) -> str:
        """For a framework that calls its model from a worker thread."""
        return asyncio.run_coroutine_threadsafe(self.complete(messages, max_tokens), self.loop).result(timeout=150)


@dataclass
class LineRequest:
    framework: str
    handle: str
    opening: str
    story: list[dict[str, Any]]
    gateway: Gateway
    system: str = ""
    user: str = ""


def prompts(framework: str, opening: str, story: list[dict[str, Any]]) -> tuple[str, str]:
    system = (
        f"You are {framework}, one of several AI agents writing a story together, one sentence each. "
        "Continue the story with exactly one new sentence in your own voice, at most 30 words. "
        "Reply with the sentence only: no quotes, no title, no explanation."
    )
    lines = [opening] + [str(e.get("line", "")) for e in story if isinstance(e, dict)]
    user = "The story so far:\n" + "\n".join(f"- {l}" for l in lines if l) + "\n\nWrite the next sentence."
    return system, user


def tidy(text: str) -> str:
    """One sentence, one line, no wrapping quotes, about 30 words at most."""
    t = " ".join(str(text or "").strip().split())
    t = t.strip().strip('"').strip("“”").strip()
    words = t.split(" ")
    if len(words) > MAX_WORDS:
        t = " ".join(words[:MAX_WORDS]).rstrip(",;:") + "..."
    return t


WriteLine = Callable[[LineRequest], Awaitable[str]]


# ── the member ──────────────────────────────────────────────────────────────


async def _health(port: int) -> None:
    async def answer(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await asyncio.wait_for(reader.read(1024), 5)
            body = b"ring member\n"
            writer.write(b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: " + str(len(body)).encode() + b"\r\nconnection: close\r\n\r\n" + body)
            await writer.drain()
        except Exception:
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(answer, "0.0.0.0", port)
    log(f"health checks answered on port {port}")
    await server.serve_forever()


def _credentials() -> tuple[Credentials, str]:
    bundle = os.environ.get("AGENTMESH_CREDENTIALS_FILE")
    if bundle:
        data = json.loads(Path(bundle).read_text(encoding="utf-8"))
        folder = Path(tempfile.mkdtemp(prefix="agentmesh-"))
        os.chmod(folder, 0o700)
        for name, key in (("agent.seed", "agent_seed"), ("mesh.creds", "mesh_creds")):
            f = folder / name
            f.write_text(str(data[key]).strip() + "\n", encoding="utf-8")
            os.chmod(f, 0o600)
        (folder / "mesh.json").write_text(json.dumps({"servers": data.get("servers") or [], "api_base": data.get("api_base")}), encoding="utf-8")
        return Credentials.load(folder), str(folder)
    folder = os.environ.get("AGENTMESH_FOLDER")
    if not folder:
        raise SystemExit("Set AGENTMESH_CREDENTIALS_FILE or AGENTMESH_FOLDER (see this folder's README: python join.py am_...).")
    folder = str(Path(folder).expanduser())
    return Credentials.load(folder), folder


def can_use(model: str, live_models: list[str]) -> bool:
    """Whether a gateway model id matches this member's declaration ("*" is any; "anthropic/*" a prefix)."""
    m = model.strip().lower()
    for pat in live_models:
        p = pat.strip().lower()
        if p == "*" or p == m or (p.endswith("*") and m.startswith(p[:-1])):
            return True
    return False


def pass_tags(live_models: list[str], via: str) -> list[str]:
    """The declaration as the ring.pass offering's tags on the card (spec section 7)."""
    return [f"ring-via:{via}"] + [f"ring-model:{m}" for m in live_models]


async def run_member(framework: str, write_line: WriteLine, description: str,
                     live_models: list[str] | None = None, via: str = "gateway") -> None:
    """Run a Ring member. ``live_models`` and ``via`` are the declaration (spec
    section 7): the model ids this member can write with in live mode (``["*"]``
    is any model the gateway serves), and whether its words come through the
    gateway or from a harness with a model of its own."""
    live_models = list(live_models if live_models is not None else ["*"])
    tags = pass_tags(live_models, via)
    handle = os.environ.get("RING_HANDLE", "").strip().lower()
    if not handle:
        raise SystemExit("Set RING_HANDLE to this member's handle, for example crewai.demo@agentmesh.ai.")
    runner = os.environ.get("RING_RUNNER", DEFAULT_RUNNER).strip().lower()
    gateway_handle = os.environ.get("RING_GATEWAY", DEFAULT_GATEWAY).strip().lower()
    local = os.environ.get("RING_LOCAL") == "1"

    if local:
        mesh = await connect([s for s in os.environ["AGENTMESH_SERVERS"].split(",") if s.strip()],
                             agent_seed=os.environ["AGENTMESH_AGENT_SEED"],
                             require_named=False, fence_inbound=False)
    else:
        creds, folder = _credentials()
        # AGENTMESH_SERVERS, when set, picks the endpoint (a Cloud Run deploy
        # sets wss://mesh.agentmesh.ai, the one that goes out over port 443).
        servers = [s for s in os.environ.get("AGENTMESH_SERVERS", "").split(",") if s.strip()] or None
        mesh = await connect(servers, credentials=creds, credentials_folder=folder, fence_inbound=False)
    keys = Keys(mesh, os.environ.get("RING_DIRECTORY") if local else None)
    loop = asyncio.get_running_loop()
    seen: dict[str, float] = {}
    tasks: set[asyncio.Task[Any]] = set()
    about = {"ring": "v1", "role": "ring-member", "role_version": 1, "handle": handle,
             "framework": framework, "via": via, "live_models": live_models, "tags": tags}

    async def carry_on(p: dict[str, Any]) -> None:
        lap = p.get("lap") if isinstance(p.get("lap"), dict) else {}
        route = p["route"]
        hop = p["hop"]
        story = [e for e in (p.get("story") or []) if isinstance(e, dict)]
        t0 = time.monotonic()
        tokens_in = tokens_out = 0
        model = str(lap.get("model") or "")
        if lap.get("mode") == "live" and not can_use(model, live_models):
            # A runner routes a member only into laps on models it declared;
            # if one arrives anyway, the story still goes on.
            line = f"({framework} cannot write with {model} and passes the story on)"
        elif lap.get("mode") == "live":
            gw_key = await keys.of(gateway_handle)
            gw = Gateway(mesh, gw_key or gateway_handle, str(p.get("lap_id")), model, loop)
            system, user = prompts(framework, str(lap.get("opening") or ""), story)
            try:
                line = tidy(await write_line(LineRequest(framework, handle, str(lap.get("opening") or ""), story, gw, system, user)))
            except Exception as exc:  # the lap goes on; the line says what happened
                log(f"lap {p.get('lap_id')}: the line could not be written: {exc}")
                line = f"({framework} could not write a line: {str(exc)[:120]})"
            tokens_in, tokens_out = gw.tokens_in, gw.tokens_out
        else:
            line = f"{framework}:{hop}"
        entry = {"by": handle, "framework": framework, "line": line, "at": now_iso(),
                 "ms": int((time.monotonic() - t0) * 1000), "tokens_in": tokens_in, "tokens_out": tokens_out}
        nxt = {**p, "story": story + [entry]}
        members = route["members"]
        if hop + 1 < len(members):
            target, offering = str(members[hop + 1]), "ring.pass"
            nxt["hop"] = hop + 1
        else:
            target, offering = runner, "ring.done"
        for attempt in (1, 2, 3):
            try:
                to = await keys.of(target)
                if not to:
                    raise RuntimeError(f"{target} does not resolve")
                await mesh.request(to, offering, nxt, timeout=30.0)
                log(f"lap {p.get('lap_id')} hop {hop}: {offering} sent to {target}")
                return
            except Exception as exc:
                log(f"lap {p.get('lap_id')} hop {hop}: {offering} to {target} failed (try {attempt}): {exc}")
                await asyncio.sleep(3 * attempt)

    @mesh.on_request("ring.pass")
    async def on_pass(p: Any, ctx: Any) -> dict[str, bool]:
        try:
            await check_pass(p, handle, runner, ctx.sender, keys)
        except RejectedError as exc:
            log(f"refused a pass from {ctx.sender[:12]}...: {exc}")
            raise
        key = f"{p.get('lap_id')}|{p['hop']}"
        if key in seen:
            return {"ok": True}
        seen[key] = time.monotonic()
        for k in [k for k, at in seen.items() if time.monotonic() - at > 3600]:
            seen.pop(k, None)
        t = asyncio.create_task(carry_on(p))
        tasks.add(t)
        t.add_done_callback(tasks.discard)
        return {"ok": True}

    @mesh.on_request("ring.about")
    async def on_about(_input: Any, _ctx: Any) -> dict[str, Any]:
        return about

    await mesh.register(
        handle.split(".", 1)[0],
        description=description,
        offerings=[
            {"id": "ring.pass", "name": "Ring pass", "tags": tags,
             "description": "Takes a Ring v1 pass, adds one line to the story and hands it on (role ring-member v1)."},
            {"id": "ring.about", "name": "Ring member facts",
             "description": "Says which framework this member is and which models it can write with in live laps."},
        ],
        # Public, so the runner can find this member's key in the registry.
        visibility="public",
        meta={"framework": framework, "roles": ["ring-member@1"]},
    )
    log(f"ring member ready: {handle} ({framework}) as {mesh.agent_id}")
    port = os.environ.get("PORT")
    if port:
        await _health(int(port))
    else:
        await asyncio.Event().wait()


def main(framework: str, write_line: WriteLine, description: str,
         live_models: list[str] | None = None, via: str = "gateway") -> None:
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(run_member(framework, write_line, description, live_models, via))
    except KeyboardInterrupt:
        pass


__all__ = ["Gateway", "LineRequest", "can_use", "pass_tags", "main", "prompts", "tidy", "now_iso", "log"]
