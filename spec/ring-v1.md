# The Ring, version 1

The Ring is a relay. A runner starts a lap with an opening line and a list of
members. Each member in turn adds one line to the story and hands the story to
the next member. The last member hands it back to the runner. Every member is a
different framework or harness, so a finished lap shows that they all speak the
same protocol.

This is the shared contract for every member in this repository, for the
runner (`ring.demo@agentmesh.ai`) and for the model gateway
(`models.platform@agentmesh.ai`). An agent that follows it holds the role
**Ring member** (role id `ring-member`, version 1).

## 1. The parties

| Party | Handle | What it does |
|---|---|---|
| Runner | `ring.demo@agentmesh.ai` | Starts laps, signs each lap's route, receives the finished story. |
| Model gateway | `models.platform@agentmesh.ai` | Writes a member's line in live mode. Holds the model keys. |
| Members | listed in each lap's route | Check the pass, add a line, hand it on. |

The first five members are `crewai.demo@agentmesh.ai`,
`langchain.demo@agentmesh.ai`, `adk.demo@agentmesh.ai`,
`claude-code.demo@agentmesh.ai` and `mastra.demo@agentmesh.ai`.

## 2. The pass

A member offers `ring.pass`. A `ring.pass` request's input is:

```json
{
  "ring": "v1",
  "lap_id": "<uuid>",
  "hop": 1,
  "lap": {
    "model": "<gateway model id>",
    "mode": "live",
    "opening": "<first line>",
    "started_at": "<ISO 8601>"
  },
  "route": {
    "members": ["<handle>", "<handle>", "..."],
    "runner": "ring.demo@agentmesh.ai",
    "issued_at": "<ISO 8601>",
    "sig": "<signature>"
  },
  "story": [
    { "by": "<handle>", "framework": "<name>", "line": "<text>", "at": "<ISO 8601>",
      "ms": 812, "tokens_in": 64, "tokens_out": 21 }
  ]
}
```

- `hop` is the index, in `route.members`, of the member receiving the pass.
- `lap.mode` is `"live"` or `"fixed"`.
- `story` holds one entry per member that has already added its line, in order.

`ring.done` has the same input. The last member sends it to the runner.

## 3. The route signature

`route.sig` is the runner's Ed25519 signature, made with the runner's own
agent key (the key `ring.demo@agentmesh.ai` resolves to at the naming
service), over the UTF-8 bytes of

```
agentmesh-ring-route-v1 LF canonical-json(route without "sig")
```

That is the tag `agentmesh-ring-route-v1`, one line feed (0x0A), then the
canonical JSON of the `route` object with the `sig` member removed. Canonical
JSON is the one AgentMesh signs everything with (object keys sorted, no
whitespace, strings and numbers as JavaScript's `JSON.stringify` writes them);
the SDKs export it as `canonicalJSON` (TypeScript) and
`agentmesh.canonical.canonical_json` (Python). This is the same tagged form as
every other AgentMesh signature, so `signTagged` and `verifyTagged` (TypeScript)
or `sign_tagged` and `verify_tagged` (Python) with the prefix
`"agentmesh-ring-route-v1\n"` produce and check it.

The signature is written as unpadded base64url. A verifier also accepts it
padded.

The signature covers the member list, the runner and the time the route was
issued, so nobody can add, remove or reorder members, or reuse a route under a
different runner.

## 4. What a member does with a pass

A member MUST, in this order:

1. **Check the signature.** Resolve `route.runner` only if it is the runner
   the member trusts (`ring.demo@agentmesh.ai` unless configured
   otherwise); take that handle's key from the naming service and verify
   `route.sig` against it. A route naming another runner, or a signature that
   does not verify, is refused with `route signature invalid`.
2. **Check the hop.** `hop` is a whole number, `0 <= hop < len(route.members)`,
   and `route.members[hop]` is the member's own handle. Otherwise it is
   refused with `wrong hop`.
3. **Check the sender.** The request's envelope sender (the signed `from`
   key) is the key of `route.members[hop - 1]`, or of the runner when `hop` is
   0. Otherwise it is refused with `wrong sender`.
4. **Answer at once** with `{"ok": true}`. The answer does not wait for the
   line.
5. **Add its entry** to `story`:
   - `by`: its own handle.
   - `framework`: its framework name (the first five use the name part of their
     handle: `crewai`, `langchain`, `adk`, `claude-code`, `mastra`).
   - `line`: in mode `"fixed"`, exactly `"<framework>:<hop>"`, for example
     `"crewai:0"`. In mode `"live"`, one new sentence continuing the story in
     the member's own voice, at most about 30 words, written by asking the
     gateway (section 5) with `lap.model` (a harness member: by its harness,
     with `lap.model`, section 7).
   - `at`: when the line was ready, ISO 8601 UTC.
   - `ms`: how long the line took, in whole milliseconds.
   - `tokens_in`, `tokens_out`: what the gateway reported, or 0 and 0 in
     fixed mode.
6. **Hand it on.** If it is not the last member, send a `ring.pass` request
   with the same `lap_id`, `lap` and `route`, `hop + 1`, and the longer
   `story`, to `route.members[hop + 1]`. If it is the last member, send
   `ring.done` with the same input (its `hop` unchanged) to the runner.

A member whose words come through the gateway never calls a model provider
directly and holds no model key. A harness member (section 7) writes with its
harness's own model instead, and only in laps on a model it declared.

If a live pass arrives on a model the member did not declare (a runner should
never route one), the member still does steps 4 to 6, with the line
`"(<framework> cannot write with <model> and passes the story on)"` and tokens
0 and 0, so the lap is not lost.

A refusal is the request's `rejected` answer with the reason as its message:
`route signature invalid`, `wrong hop` or `wrong sender`. A refused pass is not
answered with `{"ok": true}`, gets no line, and is not handed on.

A member that receives the same pass twice (the same `lap_id` and `hop`, which
happens when a mailbox delivers again after a restart) answers `{"ok": true}`
again and does not hand it on a second time.

## 5. The model gateway

In live mode a member sends a `model.complete` request to
`models.platform@agentmesh.ai`:

```json
{ "lap_id": "<uuid>", "model": "<lap.model>",
  "messages": [ { "role": "system", "content": "..." }, { "role": "user", "content": "..." } ],
  "max_tokens": 120 }
```

and gets back

```json
{ "text": "...", "model": "...", "tokens_in": 64, "tokens_out": 21, "ms": 812 }
```

The gateway serves only members of an active lap's route, and only for that
lap. The member puts the gateway's `tokens_in` and `tokens_out` on its story
entry.

## 6. The conformance check

`tests/ring-check.mjs` in this repository is the Ring member conformance check.
Given a member (a folder here, or any program that starts a member), it runs a
local mesh, a local test runner and two local peers, and checks in fixed mode
that the member:

1. passes on a correct hop (answers `{"ok": true}` and hands the pass on with
   its entry added);
2. refuses a bad signature;
3. refuses a wrong sender;
4. refuses a wrong hop;
5. forwards to the right next member, and only to it;
6. sends `ring.done` to the runner when it is last;
7. declares the models it can write with (section 7).

It makes no model calls. `spec/fixed-mode-expected.json` holds the expected
result of each case.

A member that carries the `ring-pubsub` tag (section 9) also runs five pub/sub
cases, with the test runner publishing rounds on its own feed on the local
mesh. The member:

8. answers a round with `ring.line` carrying `<framework>:pubsub`;
9. ignores a round whose envelope is not from the runner's key;
10. answers each lap once, even when the round comes twice;
11. sits out a live round on a model it did not declare;
12. answers a round published while it was stopped when it starts again, with
    `"late": true` (its subscription is durable).

## 7. Which models a member can write with

Each member declares which models it can write with in live mode, and a runner
puts a member only into laps on a model it declared. The declaration is in the
**tags of the `ring.pass` offering** on the member's card:

- `ring-via:gateway` or `ring-via:harness`. A gateway member's words come from
  the model gateway. A harness member runs a harness (Claude Code, for
  example) that calls its own model provider, and the gateway is not involved.
- `ring-model:<pattern>`, repeatable: `*` (any model the gateway serves), a
  prefix ending in `*` such as `anthropic/*`, or an exact gateway model id.
  `ring-model:none` matches no model: a harness member with no model access
  says so this way and sits out every live lap.

With no `ring-model` tag, a gateway member can write with any model and a
harness member with none. A harness member sits out every lap on a model it
cannot run.

The five members here declare:

| Member | Tags on `ring.pass` |
|---|---|
| `crewai.demo@agentmesh.ai` | `ring-via:gateway`, `ring-model:*` |
| `langchain.demo@agentmesh.ai` | `ring-via:gateway`, `ring-model:*` |
| `adk.demo@agentmesh.ai` | `ring-via:gateway`, `ring-model:*` |
| `mastra.demo@agentmesh.ai` | `ring-via:gateway`, `ring-model:*` |
| `claude-code.demo@agentmesh.ai` | `ring-via:harness`, and `ring-model:anthropic/*` when it has Anthropic access, else `ring-model:none` |

A member also answers a `ring.about` request with the same facts, which is how
the conformance check reads them without a registry:

```json
{ "ring": "v1", "role": "ring-member", "role_version": 2,
  "transports": ["point-to-point", "pubsub"],
  "handle": "crewai.demo@agentmesh.ai", "framework": "crewai",
  "via": "gateway", "live_models": ["*"],
  "tags": ["ring-via:gateway", "ring-model:*", "ring-pubsub"] }
```

A member registers as `public` (or `unlisted`), never `private`: the runner
finds each member's key in the registry.

## 8. The credential

Each member renews its connection credential when it starts, so the
credential carries what the mesh grants today; renewal needs only HTTPS. A
member keeps the saved credential when renewal fails and it is still good.

## 9. Pub/sub rounds (role ring-member v2)

A lap can also go round pub/sub. In point to point the story passes from one
named member to the next on the signed route. In pub/sub the runner publishes
one event and every subscribed member answers at once, so the lines land side
by side.

- **The round.** The runner publishes one event per round on its own feed,
  `mesh.feed.<runner key>.ring-round` (feed topic `ring-round`, kind
  `stream`): an emit envelope signed by the runner's key whose payload is
  `{ topic, kind, data }`, with `data`
  `{ "ring": "v1", "mode": "pubsub", "lap_id", "round": 1, "lap": { "model", "mode", "opening", "started_at" } }`.
- **Taking part.** A member carries the tag `ring-pubsub` on its `ring.pass`
  offering and follows that feed, where the runner key is what
  `ring.demo@agentmesh.ai` resolves to. It follows it durably
  (`subscribeFeed(runnerKey, "ring-round", handler, { durable: true })` in
  the TypeScript SDK, `subscribe_feed(..., durable=True)` in the Python SDK),
  so a round published while it was stopped reaches it when it starts again.
  A member whose mesh refuses the durable subscription follows the feed live
  and says so in its log.
- **The answer.** A member takes a round only when the envelope is from the
  runner's key (the SDK has verified its signature), sits out a live round on
  a model it did not declare (section 7), and otherwise sends `ring.line` to
  the runner at once:
  `{ "lap_id", "round", "by", "framework", "line", "at", "ms", "tokens_in", "tokens_out", "late" }`.
  In a fixed round `line` is exactly `<framework>:pubsub` with tokens 0 and 0;
  in a live round it is one sentence written from the opening, through the
  gateway (or the harness's own model). `late` is true when the round was
  published before the member's process started, which means it was stopped
  when the round went out. It answers each lap once, and does not answer a
  round published more than an hour ago.
- **The runner** takes lines as they arrive and closes the lap when every
  subscribed member that was online has answered, or after two minutes. A
  line after the close is recorded as late.
