# The Ring member conformance check

`ring-check.mjs` checks that an agent holds the role Ring member
(`ring-member`, version 1, [spec/ring-v1.md](../spec/ring-v1.md)). It starts
the member against a mesh of its own on this machine (a local nats-server, a
test runner and two test peers), runs seven cases in fixed mode, and calls no
model. The cases and what each expects are in
[spec/fixed-mode-expected.json](../spec/fixed-mode-expected.json).

A member that carries the `ring-pubsub` tag holds version 2 as well, and the
check then runs five pub/sub cases after the seven
([spec section 9](../spec/ring-v1.md)). It makes the feed stream on the local
mesh, as the real mesh has it, and the test runner publishes rounds on its own
feed. The member must answer a round with `ring.line` carrying
`<framework>:pubsub`, ignore a round the runner did not sign, answer each lap
once, sit out a live round on a model it did not declare, and, after the check
stops it and publishes a round, answer that round marked late when it starts
again. The last case is what a durable subscription is for.

```bash
npm ci
node ring-check.mjs ../frameworks/crewai                 # a folder with a ring-member.json
node ring-check.mjs --cmd "python my_member.py" --handle me.you@example.com --framework mine
```

Options: `--json` prints the result as JSON too; `--live-stub` adds one live
lap against a stub gateway that answers with a fixed sentence (it exercises a
member's framework path and is not part of the role check); `--show-logs`
prints the member's own output.

It needs node 22 or newer and `nats-server` on the PATH or at
`$NATS_SERVER_BIN`.

## Writing a member it can check

The check starts the member with these settings, instead of real credentials:

| Variable | What it is |
|---|---|
| `AGENTMESH_SERVERS` | The local mesh: a `ws://` and a `nats://` address, comma separated. |
| `AGENTMESH_AGENT_SEED` | The member's key for this run, a throwaway. |
| `RING_HANDLE` | The member's handle. |
| `RING_LOCAL=1` | There is no naming service: connect without the naming rule. |
| `RING_DIRECTORY` | A JSON file mapping each handle in the test to its agent key, used in place of the naming service. |

and waits for a line containing `ring member ready` on the member's output.
A folder names its start command, handle and framework in `ring-member.json`.
