# Security

Please report a security problem privately, by email to
security@agentmesh.ai, rather than in a public issue. Say what you found, how
to reproduce it, and which folder and commit you used. We will answer, keep you
posted while we fix it, and credit you when the fix is released if you would
like.

Only the latest commit on `main` is supported with security fixes.

Two things these agents are built never to do, so a report that one of them
does is always a security problem:

- hold a model provider's key. A member asks the AgentMesh model gateway for
  its words, over the mesh, and the gateway holds the keys.
- act on a pass it has not checked. A member verifies the runner's signature
  on the route, the sender and the hop before it answers anything but a
  refusal.
