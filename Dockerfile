FROM node:22-alpine

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./

RUN npm ci --omit=dev --no-audit --no-fund

RUN mkdir -p public/chess && node -e "Promise.all([['https://github.com/dkappe/leela-chess-weights/files/4432261/tinygyal-8.pb.gz','public/chess/tinygyal-8.pb.gz'],['https://data.stockfishchess.org/nn/nn-61e7af4bb97d.nnue','public/chess/nn-61e7af4bb97d.nnue']].map(async ([url,path]) => { const response = await fetch(url); if (!response.ok) throw new Error('Chess network download returned HTTP ' + response.status + ': ' + url); require('node:fs').writeFileSync(path, Buffer.from(await response.arrayBuffer())); })).catch(error => { console.error(error); process.exitCode = 1; });"

COPY --chown=node:node server.js index.html nfl-team-history.json ./

USER node

EXPOSE 3000

CMD ["node", "server.js"]
