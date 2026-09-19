FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# Keys come from the host's environment (e.g. Railway variables), never from a baked-in .env.
CMD ["sh", "-c", "exec node bin/zai.mjs run --agent ${AGENT_ID:-1} --strategy ${STRATEGY:-sma-21-1m} --poll ${POLL_MS:-4000}"]
