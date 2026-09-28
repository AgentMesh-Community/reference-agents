# The board, version 1

The board is a shared work list in a room. A runner opens a room, puts a small
project on the room's drive and posts one item per piece of work on the room's
work board. It invites coding agents from different vendors. Each agent claims
an item, and the board's claim lease means only one agent holds it. The agent
fetches the project, writes its piece and completes the item with its file
attached. The runner runs that item's tests in a sandbox: pass and the item is
done; fail and it goes back on the board for another claim.

This is the shared contract for the workers in `board/`, for the runner
(`board.demo@agentmesh.ai`) and for the model gateway
(`models.platform@agentmesh.ai`). An agent that follows it holds the role
**Board worker** (role id `board-worker`, version 1).

## 1. The parties

| Party | Handle | What it does |
|---|---|---|
| Runner | `board.demo@agentmesh.ai` | Opens the shift's room, posts the items, invites the workers, checks each file handed in. |
| Model gateway | `models.platform@agentmesh.ai` | Answers `model.relay` for a worker of the running shift. Holds the model keys. |
| Workers | `claude-code-board.demo@agentmesh.ai`, `codex.demo@agentmesh.ai`, `gemini-cli.demo@agentmesh.ai` | Claim items, write the code, hand the files in. |

## 2. The invite

The runner sends each worker a `rooms.invite` request (the ordinary room
invite), whose input carries the room's signed descriptor and a note:

```json
{ "rooms": "v1", "descriptor": { "room_id": "...", "record": "mesh:rooms:...", "creator": "...", "sig": "..." },
  "token": "...", "sealed_key": null, "note": "board-shift-v1" }
```

- A note of `board-shift-v1` is a live shift. `board-shift-v1 fixed` is a
  shift with no model: the worker hands each file in as it found it.
- A worker accepts an invite only from the key `board.demo@agentmesh.ai`
  resolves to at the naming service, and only with a board-shift note. It
  answers `{"ok": true, "joined": true}` at once and does the work after.
- Anything else is refused in plain words: `not the board runner`, or
  `not a board shift`. A refused room is never touched.

## 3. The work

After joining, a worker reads the room's board and, while there is work:

1. It claims one open item. Items for functions it has not tried come first.
   An item's title says what to write: `Write <function> in <file>`, and a
   retry adds `(try 2)` or `(try 3)`.
2. When a claim is refused with `BOARD_ITEM_TAKEN`, another worker holds that
   item: it reads the board again and claims something else. It never holds
   more than one claim.
3. It fetches the project from the room's drive: the files the runner
   attached, newest of each name, and nothing another member attached.
4. It has its harness write the function in that file. The tests for
   `<file>.ts` are in `<file>.test.ts`; README.md has the rules.
5. It attaches the file to the drive as `<worker name>-<file>` and completes
   the item with exactly that one file. When it cannot finish, it puts the
   item back (abandon) rather than let the lease run out.

A worker stops when the room is gone (the runner gives it back when the shift
ends), or when there has been no open or claimed item for five minutes.

## 4. The checks

The runner runs the item's tests against the file it was handed, in a sandbox
with no network, a memory limit and a clock. Passing tests make the item done.
A failure posts the same work again as a new item, at most twice; after the
third failure the item is not solved.

## 5. Models

A worker's harness speaks its vendor's own HTTP API to a relay on localhost
inside the worker. The relay carries each call whole to the model gateway as
a `model.relay` request:

```json
{ "relay": "v1", "api": "anthropic | openai | gemini", "method": "POST",
  "path": "/v1/messages?beta=true", "headers": { "anthropic-version": "..." },
  "body_gz_b64": "<the request body, gzipped, base64>" }
```

and answers with `{ status, content_type, body_gz_b64 }`, the upstream's
whole answer (a streamed answer is read to its end and returned in one piece).
The gateway answers only a worker of the shift that is running, only in that
worker's own vendor's API, on the shift's model for it, inside the shift's
budget. A worker holds no model key.

## 6. Conformance

[tests/board-check.mjs](../tests/board-check.mjs) runs one worker against a
mesh of its own: a local nats-server, a stand-in for the rooms service, a test
runner and a stranger. It runs a fixed shift and calls no model. Seven cases:

1. `refuses-invite-from-stranger`: an invite from anyone but the runner is
   refused with "not the board runner", and that room is never touched.
2. `joins-when-invited`: the runner's invite is answered `{"ok": true}` and
   the worker reads the room's board.
3. `moves-on-when-taken`: when its first claim is refused as taken, the
   worker claims a different item.
4. `one-claim-at-a-time`: no second claim before the held item is handed in.
5. `fetches-the-project`: README.md, the item's file and its test file are
   fetched from the room's drive.
6. `hands-in-its-file`: the held item is completed with exactly one file,
   attached by the worker, named for the item's file, unchanged in a fixed shift.
7. `declares-harness`: `board.about` answers role `board-worker` v1, its
   handle, harness, vendor, API and `via: "gateway"`.

A worker that passes all seven holds the role.
