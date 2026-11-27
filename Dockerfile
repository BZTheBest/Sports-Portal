FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund

RUN mkdir -p public/chess && node -e "fetch('https://github.com/dkappe/leela-chess-weights/files/4432261/tinygyal-8.pb.gz').then(async response => { if (!response.ok) throw new Error('Leela network download returned HTTP ' + response.status); require('node:fs').writeFileSync('public/chess/tinygyal-8.pb.gz', Buffer.from(await response.arrayBuffer())); }).catch(error => { console.error(error); process.exitCode = 1; });"

COPY --chown=node:node server.js index.html nfl-team-history.json ./

USER node

EXPOSE 3000

CMD ["node", "server.js"]
