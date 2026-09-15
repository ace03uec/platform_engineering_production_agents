FROM node:22-bookworm-slim
WORKDIR /opt/agent
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node AGENTS.md ./
COPY --chown=node:node src ./src
USER node
ENV NODE_ENV=production
CMD ["node", "src/main.mjs"]
