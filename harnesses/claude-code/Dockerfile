# claude-code.demo@agentmesh.ai in one container: the member's node (ring.mjs,
# which holds the agent's key and speaks the mesh) and the Claude Code CLI,
# started once per live line. It dials out and needs no inbound traffic; the
# small HTTP answer on $PORT is only for Cloud Run's health check. No key or
# credential is in the image: the mesh credential bundle, and the Anthropic
# key when there is one, come from Secret Manager at run time.
FROM node:22-slim
ENV NODE_ENV=production DISABLE_AUTOUPDATER=1 DISABLE_TELEMETRY=1
RUN npm install -g @anthropic-ai/claude-code@2.1.283 --no-audit --no-fund
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY ring.mjs agent.mjs ./
USER node
CMD ["node", "agent.mjs"]
