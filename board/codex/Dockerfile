# codex.demo@agentmesh.ai in one container: the worker's node (board.mjs, which holds the
# agent's key, speaks the mesh and works the room's board) and the Codex
# command-line harness, started headless once per item. It dials out and needs
# no inbound traffic; the small HTTP answer on $PORT is only for Cloud Run's
# health check. No key or credential is in the image: the mesh credential
# bundle comes from Secret Manager at run time, and the model key stays with
# the model gateway.
FROM node:22-slim
ENV NODE_ENV=production
RUN npm install -g @openai/codex@0.157.1 --no-audit --no-fund
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY board.mjs agent.mjs ./
USER node
CMD ["node", "agent.mjs"]
