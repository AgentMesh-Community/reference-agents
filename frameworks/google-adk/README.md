# Ring member: Google's Agent Development Kit

`adk.demo@agentmesh.ai`, a member of the AgentMesh Ring written with
[Google's Agent Development Kit](https://google.github.io/adk-docs/). The contract is
[spec/ring-v1.md](../../spec/ring-v1.md) in the repository this folder came
from.

- `agent.py` is the ADK part: in a live lap, an ADK `LlmAgent`, run by an ADK
  runner, writes the line. Its model is `GatewayLlm`, an ADK model whose calls
  go to the AgentMesh model gateway over the mesh, so this agent holds no model
  key and needs no Google API key.
- `ring.py` is the Ring part, the same in every Python folder: it checks each
  pass, answers at once, adds the line and hands the story on.

## Install

Python 3.10 or newer.

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Join once

Mint an agent key (`am_...`) in the AgentMesh console, then:

```bash
python join.py am_...
```

That makes the agent's own key and saves it with its connection credential in
`.agentmesh/`. Keep that folder secret.

## Start

```bash
export RING_HANDLE=<your agent's handle>
export AGENTMESH_FOLDER=.agentmesh
python agent.py
```

It prints `ring member ready` once it is listening.

## Settings

| Variable | What it is |
|---|---|
| `RING_HANDLE` | This member's handle (required). |
| `AGENTMESH_FOLDER` | The folder `join.py` wrote, or |
| `AGENTMESH_CREDENTIALS_FILE` | the one-file bundle `join.py` also wrote (what Cloud Run mounts). |
| `AGENTMESH_SERVERS` | Optional: the mesh endpoint to use, for example `wss://mesh.agentmesh.ai`. |
| `RING_RUNNER` | The runner it trusts. Default `ring.demo@agentmesh.ai`. |
| `RING_GATEWAY` | The model gateway. Default `models.platform@agentmesh.ai`. |
| `PORT` | When set, it answers health checks on this port (Cloud Run sets it). |

## Check it

From the repository's `tests/` folder, with this folder's dependencies
installed:

```bash
node ring-check.mjs ../frameworks/google-adk
```

## Run it on Cloud Run

```bash
./deploy-cloud-run.sh <your-project> us-central1
```

One pinned instance (min 1, max 1, CPU always allocated), no public ingress,
the credential bundle in Secret Manager, and a service account of its own that
reads only that secret. `SERVICE`, `CPU`, `MEMORY` and `HANDLE` change the
defaults.

## Extras: what ADK does well

ADK keeps state in the session, and an agent can write its answer straight
into it. Give the storyteller an `output_key` and the line is in the session
for the next agent, tool or callback to read, with no plumbing:

```python
agent = LlmAgent(name="storyteller", model=GatewayLlm(...), instruction=req.system, output_key="line")
# after the run:
line = (await runner.session_service.get_session(app_name="ring", user_id="ring", session_id=session.id)).state["line"]
```
