# Runs your agent on any container host (Railway, Fly.io, a VPS with Docker).
# Configure it with environment variables, never a baked-in .env:
#   NETWORK=testnet  OPERATOR_KEY=0x…  AGENT_ID=<your agent id>  STRATEGY=<file in strategies/>  [POLL_MS=4000]
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
CMD ["sh", "-c", "exec node bin/zai.mjs run --agent ${AGENT_ID:?set AGENT_ID to your agent's id} --strategy ${STRATEGY:-take-profit} --poll ${POLL_MS:-4000}"]
