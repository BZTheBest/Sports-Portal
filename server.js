const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const nflFantasyData = require("./data/nfl-perry-party.json");
const TRANSFERMARKT = "https://www.transfermarkt.us";
const TM_API = "https://tmapi.transfermarkt.technology";
const cache = new Map();
const wikipediaCache = new Map();
const sportsCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;
const WIKIPEDIA_CACHE_TTL = 24 * 60 * 60 * 1000;
const SPORTS_CACHE_TTL = 2 * 60 * 1000;

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

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; FulltimePlayerSearch/1.0)",
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Sports data provider returned HTTP ${response.status}`);
  return response.json();
}

function cached(key) {
  const entry = sportsCache.get(key);
  return entry && entry.expiresAt > Date.now() ? entry.value : null;
}

function cacheSports(key, value) {
  sportsCache.set(key, { value, expiresAt: Date.now() + SPORTS_CACHE_TTL });
  return value;
}

function validDate(value) {
  return /^\d{8}$/.test(value) && Number.isFinite(Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00Z`));
}

function loadNflFantasy() {
  return nflFantasyData;
}

async function nbaSlate(date) {
  const key = `nba-slate:${date}`;
  const hit = cached(key);
  if (hit) return hit;
  const board = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`);
  const events = board.events || [];
  const matchups = events.map(event => {
    const competition = event.competitions?.[0];
    return {
      id: event.id,
      date: event.date,
      status: event.status?.type?.name || "",
      teams: (competition?.competitors || []).map(item => ({
        id: String(item.team?.id || ""),
        name: item.team?.displayName || item.team?.name || ""
      }))
    };
  });
  const teamIds = [...new Set(matchups.flatMap(event => event.teams.map(team => team.id)).filter(Boolean))];
  const rosters = await Promise.all(teamIds.map(async id => {
    const response = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${encodeURIComponent(id)}?enable=roster`);
    const team = response.team || {};
    return (team.athletes || []).filter(player => player.active !== false).map(player => ({
      id: String(player.id),
      name: player.fullName || player.displayName,
      teamId: String(team.id || id),
      team: team.displayName || team.name || "",
      position: player.position?.abbreviation || player.position?.displayName || "",
      headshot: player.headshot || ""
    }));
  }));
  const teamGames = new Map();
  for (const event of matchups) {
    for (const team of event.teams) teamGames.set(team.id, event);
  }
  const players = [...new Map(rosters.flat().map(player => {
    const game = teamGames.get(player.teamId);
    return [player.id, { ...player, game: game ? `${game.teams[0]?.name} vs ${game.teams[1]?.name}` : "", gameStatus: game?.status || "" }];
  })).values()];
  return cacheSports(key, { date, events: matchups, players });
}

async function nbaResults(date) {
  const key = `nba-results:${date}`;
  const hit = cached(key);
  if (hit) return hit;
  const board = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${date}`);
  const events = board.events || [];
  const scores = {};
  let pending = 0;
  await Promise.all(events.map(async event => {
    const status = event.status?.type?.name || "";
    if (!/FINAL|POST/i.test(status)) {
      pending += 1;
      return;
    }
    const summary = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${encodeURIComponent(event.id)}`);
    for (const team of summary.boxscore?.players || []) {
      for (const group of team.statistics || []) {
        const pointsIndex = (group.keys || []).indexOf("points");
        if (pointsIndex < 0) continue;
        for (const athlete of group.athletes || []) {
          const id = String(athlete.athlete?.id || "");
          const points = Number(athlete.stats?.[pointsIndex]);
          if (id && Number.isFinite(points)) scores[id] = points;
        }
      }
    }
  }));
  return cacheSports(key, { date, scores, pending, games: events.length });
}

async function premierLeagueFantasy() {
  const key = "fantasy:premier-league";
  const hit = cached(key);
  if (hit) return hit;
  const payload = await fetchJson("https://fantasy.premierleague.com/api/bootstrap-static/");
  const teams = new Map((payload.teams || []).map(team => [team.id, team.name]));
  const players = (payload.elements || []).map(player => ({
    name: `${player.first_name || ""} ${player.second_name || ""}`.trim(),
    displayName: player.web_name || "",
    team: teams.get(player.team) || "",
    position: player.element_type || 0,
    points: Number(player.total_points) || 0,
    price: Number(player.now_cost) / 10
  }));
  return cacheSports(key, {
    season: payload.events?.find(event => event.is_current)?.name || "",
    source: "Official Fantasy Premier League",
    players
  });
}

function normalizePlayerName(value = "") {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

async function playerAvailability(sport, league, playerName) {
  const normalizedSport = sport.toLowerCase();
  const espnPath = normalizedSport === "nba"
    ? "basketball/nba"
    : normalizedSport === "nfl"
      ? "football/nfl"
      : normalizedSport === "soccer" && league
        ? `soccer/${league}`
        : "";
  if (!espnPath) return { reports: [], source: "ESPN", unsupported: true };
  const key = `injuries:${espnPath}`;
  let reports = cached(key);
  if (!reports) {
    const payload = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/${espnPath}/injuries`);
    reports = (payload.injuries || []).flatMap(team => (team.injuries || []).map(item => ({
      athleteId: String(item.athlete?.id || ""),
      name: item.athlete?.displayName || "",
      status: item.status || "",
      shortComment: item.shortComment || "",
      longComment: item.longComment || "",
      reportDate: item.date || "",
      team: team.displayName || ""
    })));
    cacheSports(key, reports);
  }
  const query = normalizePlayerName(playerName);
  const result = reports.filter(item => normalizePlayerName(item.name) === query);
  return { reports: result, source: "ESPN", unsupported: false };
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

async function fetchWikipediaPopularity(name, includeSummary = false) {
  const cacheKey = normalizeName(name);
  const cached = wikipediaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() && (!includeSummary || cached.value.extract)) return cached.value;

  const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
  searchUrl.search = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: name,
    srnamespace: "0",
    srlimit: "5",
    format: "json"
  });
  const searchResponse = await fetch(searchUrl, {
    headers: { Accept: "application/json", "User-Agent": "FULLTIMEPlayerSearch/1.0 (player popularity ranking)" },
    signal: AbortSignal.timeout(10000)
  });
  if (!searchResponse.ok) throw new Error(`Wikipedia search returned HTTP ${searchResponse.status}`);
  const searchPayload = await searchResponse.json();
  const pages = searchPayload.query?.search || [];
  const exact = pages.find(page => normalizeName(page.title) === cacheKey);
  const qualified = pages.filter(page => {
    const title = normalizeName(page.title);
    return title.startsWith(`${cacheKey} `) || (!cacheKey.includes(" ") && title.endsWith(` ${cacheKey}`));
  });
  const candidates = cacheKey.includes(" ") ? (exact ? [exact] : qualified) : (qualified.length ? qualified : exact ? [exact] : []);
  if (!candidates.length) {
    const value = { views: 0, title: "" };
    wikipediaCache.set(cacheKey, { value, expiresAt: Date.now() + WIKIPEDIA_CACHE_TTL });
    return value;
  }

  const end = new Date();
  end.setUTCDate(end.getUTCDate() - 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  const startDate = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}-${String(start.getUTCDate()).padStart(2, "0")}`;
  const endDate = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}-${String(end.getUTCDate()).padStart(2, "0")}`;
  const pageViewsUrl = new URL("https://en.wikipedia.org/w/api.php");
  pageViewsUrl.search = new URLSearchParams({
    action: "query",
    prop: "pageviews",
    titles: candidates.map(page => page.title).join("|"),
    format: "json"
  });
  const viewsResponse = await fetch(pageViewsUrl, {
    headers: { Accept: "application/json", "User-Agent": "FULLTIMEPlayerSearch/1.0 (player popularity ranking)" },
    signal: AbortSignal.timeout(10000)
  });
  if (!viewsResponse.ok) throw new Error(`Wikipedia page-view data returned HTTP ${viewsResponse.status}`);
  const viewsPayload = await viewsResponse.json();
  const pageData = Object.values(viewsPayload.query?.pages || {});
  const viewsFor = page => {
    const data = pageData.find(item => normalizeName(item.title) === normalizeName(page.title));
    return Object.entries(data?.pageviews || {}).reduce((total, [date, count]) =>
      date >= startDate && date <= endDate ? total + (Number(count) || 0) : total, 0);
  };
  candidates.sort((left, right) => viewsFor(right) - viewsFor(left));
  const page = candidates[0];
  const value = {
    views: viewsFor(page),
    title: page.title
  };
  if (includeSummary) {
    const summaryResponse = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.title)}`, {
      headers: { Accept: "application/json", "User-Agent": "FULLTIMEPlayerSearch/1.0 (player popularity ranking)" },
      signal: AbortSignal.timeout(10000)
    });
    if (!summaryResponse.ok) throw new Error(`Wikipedia profile returned HTTP ${summaryResponse.status}`);
    const summary = await summaryResponse.json();
    value.extract = summary.extract || "";
    value.url = summary.content_urls?.desktop?.page || "";
  }
  wikipediaCache.set(cacheKey, { value, expiresAt: Date.now() + WIKIPEDIA_CACHE_TTL });
  return value;
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
    clubSince: assignment?.start || "",
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

  if (requestUrl.pathname === "/api/nba/slate" || requestUrl.pathname === "/api/nba/results") {
    const date = requestUrl.searchParams.get("date") || "";
    if (!validDate(date)) {
      sendJson(response, 400, { error: "Date must use YYYYMMDD format." });
      return;
    }
    try {
      const value = requestUrl.pathname.endsWith("/slate") ? await nbaSlate(date) : await nbaResults(date);
      sendJson(response, 200, value);
    } catch (error) {
      sendJson(response, 502, { error: `ESPN NBA data failed: ${error.message}` });
    }
    return;
  }

  if (requestUrl.pathname === "/api/fantasy/premier-league") {
    try {
      sendJson(response, 200, await premierLeagueFantasy());
    } catch (error) {
      sendJson(response, 502, { error: `Fantasy Premier League data failed: ${error.message}` });
    }
    return;
  }

  if (requestUrl.pathname === "/api/nfl/perry-party") {
    try {
      sendJson(response, 200, await loadNflFantasy());
    } catch (error) {
      sendJson(response, 502, { error: `Historical NFL fantasy data failed: ${error.message}` });
    }
    return;
  }

  if (requestUrl.pathname === "/api/player/availability") {
    const sport = (requestUrl.searchParams.get("sport") || "").trim().toLowerCase();
    const name = (requestUrl.searchParams.get("name") || "").trim();
    const league = (requestUrl.searchParams.get("league") || "").trim().toLowerCase();
    const allowedLeagues = new Set(["eng.1", "esp.1", "ita.1", "ger.1", "fra.1"]);
    if (!["nba", "nfl", "soccer"].includes(sport) || name.length < 2 || name.length > 100 || (sport === "soccer" && !allowedLeagues.has(league))) {
      sendJson(response, 400, { error: "Provide a supported sport, player name, and (for soccer) a supported league." });
      return;
    }
    try {
      sendJson(response, 200, await playerAvailability(sport, league, name));
    } catch (error) {
      sendJson(response, 502, { error: `Player availability could not be loaded: ${error.message}` });
    }
    return;
  }

  if (requestUrl.pathname === "/api/wikipedia/popularity") {
    let names;
    try {
      names = JSON.parse(requestUrl.searchParams.get("names") || "[]");
    } catch {
      sendJson(response, 400, { error: "Player names must be a JSON array." });
      return;
    }
    const focusName = (requestUrl.searchParams.get("focus") || "").trim();
    if (!Array.isArray(names) || names.length > 30 || names.some(name => typeof name !== "string" || name.trim().length < 2 || name.length > 80) || (focusName && (focusName.length < 2 || focusName.length > 80))) {
      sendJson(response, 400, { error: "Provide up to 30 player names, each between 2 and 80 characters." });
      return;
    }
    try {
      const uniqueNames = [...new Map([...(focusName ? [focusName] : []), ...names].map(name => [normalizeName(name), name.trim()])).values()];
      const results = [];
      for (let index = 0; index < uniqueNames.length; index += 8) {
        const batch = await Promise.all(uniqueNames.slice(index, index + 8).map(async name => {
          try {
            return { key: normalizeName(name), value: await fetchWikipediaPopularity(name, normalizeName(name) === normalizeName(focusName)) };
          } catch (error) {
            return { key: normalizeName(name), value: null, error: `${name}: ${error.message}` };
          }
        }));
        results.push(...batch);
      }
      const focus = results.find(result => result.key === normalizeName(focusName))?.value || null;
      sendJson(response, 200, {
        players: Object.fromEntries(results.map(result => [result.key, result.value])),
        focus,
        errors: results.filter(result => result.error).map(result => result.error)
      });
    } catch (error) {
      sendJson(response, 502, { error: `Wikipedia popularity lookup failed: ${error.message}` });
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
