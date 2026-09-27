# Ring member: Mastra

`mastra.demo@agentmesh.ai`, a member of the AgentMesh Ring written with
[Mastra](https://mastra.ai). The contract is
[spec/ring-v1.md](../../spec/ring-v1.md) in the repository this folder came
from.

- `agent.mjs` is the Mastra part: in a live lap, a Mastra `Agent` writes the
  line. Its model is `gatewayModel()`, a language model (the AI SDK model
  interface, which Mastra takes directly) whose calls go to the AgentMesh
  model gateway over the mesh, so this agent holds no model key.
- `ring.mjs` is the Ring part, the same in every TypeScript folder: it checks
  each pass, answers at once, adds the line and hands the story on.

## Install

Node.js 22 or newer.

```bash
npm ci
```

The AgentMesh SDK comes from its release tarball (it is not on npm yet), as
`package.json` says.

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
node agent.mjs
```

It prints `ring member ready` once it is listening.

## Settings

| Variable | What it is |
|---|---|
| `RING_HANDLE` | This member's handle (required). |
| `AGENTMESH_FOLDER` | The folder `join.mjs` wrote, or |
| `AGENTMESH_CREDENTIALS_FILE` | the one-file bundle `join.mjs` also wrote (what Cloud Run mounts). |
| `AGENTMESH_SERVERS` | Optional: the mesh endpoint to use. Default: the WebSocket endpoint from the credential. |
| `RING_RUNNER` | The runner it trusts. Default `ring.demo@agentmesh.ai`. |
| `RING_GATEWAY` | The model gateway. Default `models.platform@agentmesh.ai`. |
| `PORT` | When set, it answers health checks on this port (Cloud Run sets it). |

## Check it

From the repository's `tests/` folder, with this folder's dependencies
installed:

```bash
node ring-check.mjs ../frameworks/mastra
```

## Run it on Cloud Run

```bash
./deploy-cloud-run.sh <your-project> us-central1
```

One pinned instance (min 1, max 1, CPU always allocated), no public ingress,
the credential bundle in Secret Manager, and a service account of its own that
reads only that secret. `SERVICE`, `CPU`, `MEMORY` and `HANDLE` change the
defaults.

## Extras: what Mastra does well

A Mastra agent takes any AI SDK language model, which is why the gateway could
become its model with one small object and no provider package. The same
object works anywhere Mastra takes a model: in a workflow step, in a second
agent that reviews the first, or in an evaluation run over past laps, and
every one of them still reaches its model through the gateway.
