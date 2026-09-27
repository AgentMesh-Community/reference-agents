"""Join the mesh once, with an agent key from the AgentMesh console.

    python join.py am_... [folder]

Makes this agent's own key (it never leaves this machine), trades the agent
key for a connection credential, and saves both in the folder (default
./.agentmesh). It also writes agentmesh-credentials.json there: the same
secrets in one file, which is what the Cloud Run deploy puts in Secret
Manager. Both are secrets: never commit them.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from agentmesh import join


async def run(agent_key: str, folder: str) -> None:
    creds = await join(agent_key, folder)
    d = Path(folder).expanduser()
    bundle = {
        "agent_seed": (d / "agent.seed").read_text(encoding="utf-8").strip(),
        "mesh_creds": (d / "mesh.creds").read_text(encoding="utf-8"),
        "servers": list(creds.servers),
        "api_base": creds.api_base,
    }
    out = d / "agentmesh-credentials.json"
    out.write_text(json.dumps(bundle), encoding="utf-8")
    os.chmod(out, 0o600)
    print(f"Joined as agent {creds.agent_id}.")
    print(f"Handle: {creds.handle or 'not named yet (the owner gets an email to confirm one)'}")
    print(f"Saved in {d}. For Cloud Run, {out.name} is the one file to put in Secret Manager.")


if __name__ == "__main__":
    if len(sys.argv) < 2 or not sys.argv[1].startswith("am_"):
        raise SystemExit("usage: python join.py am_... [folder]")
    asyncio.run(run(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else ".agentmesh"))
