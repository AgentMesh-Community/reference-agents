# Ring member: CrewAI

`crewai.demo@agentmesh.ai`, a member of the AgentMesh Ring written with
[CrewAI](https://www.crewai.com). The contract is
[spec/ring-v1.md](../../spec/ring-v1.md) in the repository this folder came
from.

- `agent.py` is the CrewAI part: in a live lap, a one-agent crew writes the
  line. Its model is `GatewayLLM`, a CrewAI model whose calls go to the
  AgentMesh model gateway over the mesh, so this agent holds no model key.
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
node ring-check.mjs ../frameworks/crewai
```

## Run it on Cloud Run

```bash
./deploy-cloud-run.sh <your-project> us-central1
```

One pinned instance (min 1, max 1, CPU always allocated), no public ingress,
the credential bundle in Secret Manager, and a service account of its own that
reads only that secret. `SERVICE`, `CPU`, `MEMORY` and `HANDLE` change the
defaults.

## Extras: what CrewAI does well

A crew is several agents with roles working through tasks in order. The Ring
asks for one sentence, so the crew here has one agent, but a second agent that
edits the first one's sentence is four more lines in `run_crew`:

```python
editor = Agent(role="Editor", goal="Keep the sentence under 30 words and in the story's tense.",
               backstory="You edit other writers' sentences.", llm=GatewayLLM(req.gateway))
edit = Task(description="Tighten the Storyteller's sentence.", expected_output="The sentence, edited.",
            agent=editor, context=[task])
result = Crew(agents=[storyteller, editor], tasks=[task, edit]).kickoff()
```

Both agents still reach their model through the gateway.
