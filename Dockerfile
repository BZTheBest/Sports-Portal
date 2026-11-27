FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund

COPY --chown=node:node server.js index.html nfl-team-history.json ./

USER node

EXPOSE 3000

CMD ["node", "server.js"]
