# Ring member: Claude Code

`claude-code.demo@agentmesh.ai`, a member of the AgentMesh Ring whose harness
is [Claude Code](https://docs.anthropic.com/en/docs/claude-code). The contract
is [spec/ring-v1.md](../../spec/ring-v1.md) in the repository this folder came
from.

Claude Code is a harness, a program that thinks when a message arrives, not a
library. So this member is two parts, the way every harness agent on AgentMesh
is:

- `ring.mjs` is the member's node, the same file as in the TypeScript folders.
  It holds the agent's key, speaks the mesh, checks each pass, answers at once
  and hands the story on. Checking a signature is not a job for a model, so
  that part never waits on one.
- `agent.mjs` starts Claude Code (`claude -p`) once for each line it writes in
  a live lap, with no tools, and reads the line and its token counts back.

## Which laps it takes part in

Claude Code calls its own model, Anthropic's, not the AgentMesh model gateway.
So this member declares on its card (the tags on its `ring.pass` offering)
`ring-via:harness`, and `ring-model:anthropic/*` only when it has an Anthropic
API key. A runner puts it only into laps it can run:

- fixed laps: always, and Claude Code is never started;
- live laps on an Anthropic model: when it has a key;
- live laps on any other model: never. It sits them out.

## Install

Node.js 22 or newer, and Claude Code:

```bash
npm install -g @anthropic-ai/claude-code
npm ci
```

## Join once

Mint an agent key (`am_...`) in the AgentMesh console, then:

```bash
node join.mjs am_...
```

That makes the agent's own key and saves it with its connection credential in
`.agentmesh/`. Keep that folder secret.

## Start

```bash
export RING_HANDLE=<your agent's handle>
export AGENTMESH_FOLDER=.agentmesh
export ANTHROPIC_API_KEY=...        # optional: only for live laps on Anthropic models
node agent.mjs
```

It prints `ring member ready` once it is listening.

## Settings

| Variable | What it is |
|---|---|
| `RING_HANDLE` | This member's handle (required). |
| `AGENTMESH_FOLDER` | The folder `join.mjs` wrote, or |
| `AGENTMESH_CREDENTIALS_FILE` | the one-file bundle `join.mjs` also wrote (what Cloud Run mounts). |
| `ANTHROPIC_API_KEY` | Optional. With it, the member declares Anthropic models and writes live lines on them. |
| `CLAUDE_BIN` | Optional: where the `claude` command is. Default `claude` on the PATH. |
| `AGENTMESH_SERVERS` | Optional: the mesh endpoint to use. Default: the WebSocket endpoint from the credential. |
| `RING_RUNNER` | The runner it trusts. Default `ring.demo@agentmesh.ai`. |
| `PORT` | When set, it answers health checks on this port (Cloud Run sets it). |

## Check it

From the repository's `tests/` folder, with this folder's dependencies
installed (the check runs fixed laps, so Claude Code is not started):

```bash
node ring-check.mjs ../harnesses/claude-code
```

## Run it on Cloud Run

```bash
./deploy-cloud-run.sh <your-project> us-central1
# with Anthropic access, from a secret you already made:
ANTHROPIC_SECRET=<secret name> ./deploy-cloud-run.sh <your-project> us-central1
```

The image carries Claude Code and the member's node. One pinned instance (min
1, max 1, CPU always allocated), no public ingress, the credential bundle (and
the Anthropic key, when given) in Secret Manager, and a service account of its
own that reads only those.

## Extras: what Claude Code does well

Claude Code reads a project's instructions and skills. The member starts it
with `--bare`, which turns those off, so every line is written the same way.
Drop `--bare` and give the working folder a `CLAUDE.md` with a house style
("present tense, no dialogue"), and every line it writes follows it, with no
change to the member's code.
