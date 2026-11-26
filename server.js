const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const TRANSFERMARKT = "https://www.transfermarkt.us";
const TM_API = "https://tmapi.transfermarkt.technology";
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&auml;/g, "ä")
    .replace(/&ouml;/g, "ö")
    .replace(/&uuml;/g, "ü")
    .replace(/&Auml;/g, "Ä")
    .replace(/&Ouml;/g, "Ö")
    .replace(/&Uuml;/g, "Ü")
    .replace(/&szlig;/g, "ß")
    .replace(/&amp;#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function text(value = "") {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FulltimePlayerSearch/1.0)",
      Accept: "text/html,application/json"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Transfermarkt returned HTTP ${response.status}`);
  return response.text();
}

async function fetchTransfermarktJson(endpoint) {
  const response = await fetch(`${TM_API}${endpoint}`, {
    headers: {
      Accept: "application/json",
      Origin: TRANSFERMARKT,
      Referer: `${TRANSFERMARKT}/`
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Transfermarkt data API returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.success || !payload.data) throw new Error("Transfermarkt returned an incomplete player record");
  return payload.data;
}

function parseSearchRows(page) {
  const players = [];
  const profileLinks = [...page.matchAll(/<a\b[^>]*href="([^"]*\/profil\/spieler\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi)];
  for (const profile of profileLinks) {
    const linkIndex = profile.index;
    const oddStart = page.lastIndexOf('<tr class="odd"', linkIndex);
    const evenStart = page.lastIndexOf('<tr class="even"', linkIndex);
    const rowStart = Math.max(oddStart, evenStart);
    if (rowStart < 0) continue;
    const nextOdd = page.indexOf('<tr class="odd"', linkIndex);
    const nextEven = page.indexOf('<tr class="even"', linkIndex);
    const nextRow = [nextOdd, nextEven].filter(index => index >= 0).sort((a, b) => a - b)[0];
    const row = page.slice(rowStart, nextRow < 0 ? page.indexOf("</tbody>", linkIndex) : nextRow);
    const name = text(profile[3]);
    const clubLink = row.match(/<a[^>]*title="([^"]+)"[^>]*href="[^"]*\/verein\/(\d+)"[^>]*>/i);
    const position = row.match(/<\/table>\s*<\/td>\s*<td\b[^>]*>([\s\S]*?)<\/td>/i);
    const nationality = row.match(/<img[^>]*title="([^"]+)"[^>]*class="flaggenrahmen"/i);
    const value = row.match(/<td\b[^>]*class="[^"]*rechts hauptlink[^"]*"[^>]*>([\s\S]*?)<\/td>/i);
    const url = new URL(profile[1], TRANSFERMARKT);

    players.push({
      id: profile[2],
      name,
      position: text(position?.[1] || ""),
      club: decodeHtml(clubLink?.[1] || ""),
      clubId: clubLink?.[2] || "",
      nationality: decodeHtml(nationality?.[1] || ""),
      searchValue: text(value?.[1] || ""),
      transfermarktUrl: `${url.origin}${url.pathname.replace("/profil/spieler/", "/marktwertverlauf/spieler/")}`
    });
  }
  return [...new Map(players.map(player => [player.id, player])).values()];
}

function formatMarketValue(record) {
  if (!record?.compact) return "";
  const { prefix = "", content = "", suffix = "" } = record.compact;
  return `${prefix}${content}${suffix}`;
}

function marketValueAmount(value = "") {
  const match = String(value).match(/([\d,.]+)\s*(B|M|K)?/i);
  if (!match) return 0;
  const amount = Number(match[1].replace(/,/g, ""));
  const multiplier = match[2]?.toUpperCase() === "B" ? 1000 : match[2]?.toUpperCase() === "K" ? 0.001 : 1;
  return Number.isFinite(amount) ? amount * multiplier : 0;
}

function normalizeName(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

async function enrichPlayer(result) {
  const [player, history] = await Promise.all([
    fetchTransfermarktJson(`/player/${encodeURIComponent(result.id)}`),
    fetchTransfermarktJson(`/player/${encodeURIComponent(result.id)}/market-value-history`)
  ]);
  const assignment = player.clubAssignments?.find(item => item.type === "current");
  const clubId = assignment?.clubId || player.lastClubId;
  let club = null;
  let league = "";
  let leagueId = "";
  let enrichmentError = "";
  if (clubId && String(clubId) !== "0") {
    try {
      club = await fetchTransfermarktJson(`/club/${encodeURIComponent(clubId)}`);
      const competitionId = club.baseDetails?.primaryCompetitionId || club.relevantCompetitionId;
      if (competitionId) {
        const competition = await fetchTransfermarktJson(`/competition/${encodeURIComponent(competitionId)}`);
        league = competition.name || "";
        leagueId = String(competition.id || competitionId);
      }
    } catch (error) {
      enrichmentError = error.message;
    }
  }

  const historyRows = history.history || [];
  const peak = historyRows.reduce((highest, item) =>
    Number(item.marketValue?.value || 0) > Number(highest?.marketValue?.value || 0) ? item : highest, null);
  const current = player.marketValueDetails?.current;
  const highest = player.marketValueDetails?.highest || peak?.marketValue;

  return {
    ...result,
    name: player.name || result.name,
    position: player.attributes?.position?.name || result.position,
    nationality: result.nationality || "",
    club: club?.name || result.club,
    clubId: clubId ? String(clubId) : "",
    league,
    leagueId,
    clubCountryId: club?.baseDetails?.countryId ? String(club.baseDetails.countryId) : "",
    isNationalTeam: club?.baseDetails?.isNationalTeam === true,
    marketValue: formatMarketValue(current) || result.searchValue,
    marketValueDate: current?.determined || "",
    peakMarketValue: formatMarketValue(highest),
    peakMarketValueDate: highest?.determined || peak?.marketValue?.determined || "",
    enrichmentError,
    transfermarktUrl: player.relativeUrl
      ? `${TRANSFERMARKT}${player.relativeUrl.replace("/profil/spieler/", "/marktwertverlauf/spieler/")}`
      : result.transfermarktUrl
  };
}

async function searchPlayers(query) {
  const cacheKey = query.toLocaleLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const searchUrl = new URL("/schnellsuche/ergebnis/schnellsuche", TRANSFERMARKT);
  searchUrl.searchParams.set("query", query);
  searchUrl.searchParams.set("type", "spieler");
  const page = await fetchText(searchUrl);
  const normalizedQuery = normalizeName(query);
  const queryTokens = normalizedQuery.split(" ");
  const relevance = player => {
    const name = normalizeName(player.name);
    const nameTokens = name.split(" ");
    if (name === normalizedQuery) return 3;
    if (queryTokens.length === 1 && (nameTokens.at(-1) === normalizedQuery || nameTokens[0] === normalizedQuery)) return 2;
    if (name.includes(normalizedQuery) || queryTokens.every(token => nameTokens.some(nameToken => nameToken.startsWith(token) || token.startsWith(nameToken)))) return 1;
    return 0;
  };
  const matches = parseSearchRows(page)
    .filter(player => relevance(player) > 0)
    .sort((left, right) => relevance(right) - relevance(left) || marketValueAmount(right.searchValue) - marketValueAmount(left.searchValue));
  const enriched = await Promise.all(matches.slice(0, 6).map(async player => {
    try {
      return await enrichPlayer(player);
    } catch (error) {
      return { ...player, enrichmentError: error.message };
    }
  }));
  const value = enriched.sort((left, right) => {
    return relevance(right) - relevance(left) || marketValueAmount(right.marketValue || right.searchValue) - marketValueAmount(left.marketValue || left.searchValue);
  });
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  if (requestUrl.pathname === "/api/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (requestUrl.pathname === "/api/transfermarkt/search") {
    const query = (requestUrl.searchParams.get("q") || "").trim();
    if (query.length < 2 || query.length > 80) {
      sendJson(response, 400, { error: "Search term must be between 2 and 80 characters." });
      return;
    }
    try {
      sendJson(response, 200, { players: await searchPlayers(query) });
    } catch (error) {
      sendJson(response, 502, { error: `Transfermarkt search failed: ${error.message}` });
    }
    return;
  }

  if (request.method !== "GET" || requestUrl.pathname !== "/") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  fs.readFile(path.join(ROOT, "index.html"), (error, content) => {
    if (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("The site could not be loaded.");
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    response.end(content);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`FULLTIME listening on port ${PORT}`);
});
