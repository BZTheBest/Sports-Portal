let engine;
let activeSearchId;

function reportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage({ type: "error", id: activeSearchId, message });
}

async function initialize() {
  try {
    const [module, networkResponse] = await Promise.all([
      import("/chess-assets/stockfish.js"),
      fetch("/chess-assets/nn-61e7af4bb97d.nnue")
    ]);
    if (!networkResponse.ok) {
      throw new Error(`Stockfish network returned HTTP ${networkResponse.status}`);
    }
    const network = new Uint8Array(await networkResponse.arrayBuffer());
    engine = await module.default({
      locateFile: file => new URL(file === "sf_19_smallnet.wasm" ? "/chess-assets/stockfish.wasm" : file, self.location.origin).href,
      mainScriptUrlOrBlob: "/chess-assets/stockfish.js",
      listen: line => {
        if (line === "uciok") {
          setTimeout(() => {
            engine.uci("setoption name Threads value 1");
            engine.uci("setoption name Hash value 128");
            engine.uci("isready");
          });
        } else if (line === "readyok" && activeSearchId === undefined) {
          self.postMessage({ type: "ready" });
        } else if (line.startsWith("bestmove ") && activeSearchId !== undefined) {
          self.postMessage({ type: "line", id: activeSearchId, line });
          activeSearchId = undefined;
        } else if (activeSearchId !== undefined) {
          self.postMessage({ type: "line", id: activeSearchId, line });
        }
      },
      onError: message => reportError(message)
    });
    engine.setNnueBuffer(network);
    engine.uci("uci");
  } catch (error) {
    reportError(error);
  }
}

self.addEventListener("message", event => {
  const { type, id, fen, movetime } = event.data;
  if (type === "init") {
    void initialize();
    return;
  }
  if (type === "search" && engine && activeSearchId === undefined) {
    activeSearchId = id;
    engine.uci(`position fen ${fen}`);
    engine.uci(`go movetime ${movetime}`);
  }
});
