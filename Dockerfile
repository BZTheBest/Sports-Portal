FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json server.js index.html ./
COPY --chown=node:node data ./data

USER node

EXPOSE 3000

CMD ["node", "server.js"]
