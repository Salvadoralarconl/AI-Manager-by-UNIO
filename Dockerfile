# AI Manager: one image for both the web dashboard and the runner.
# No npm install step: the app has zero runtime dependencies.
FROM node:22-alpine

ENV NODE_ENV=production \
    DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8080

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public

# /data is a volume; creating it here makes a fresh named volume owned by "node".
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080

CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
