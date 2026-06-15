const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const FOOTBALL_DATA_MATCHES_URL = "https://api.football-data.org/v4/competitions/WC/matches";
const LIVE_CACHE_SECONDS = 300;

const TEAM_ALIASES = {
  "United States": "USA",
  "United States of America": "USA",
  "Korea Republic": "South Korea",
  "Czech Republic": "Czechia",
  "Turkiye": "Turkey",
  "Türkiye": "Turkey",
  "IR Iran": "Iran",
  "Côte d'Ivoire": "Ivory Coast",
  "Cote d'Ivoire": "Ivory Coast",
  "Congo DR": "DR Congo",
  "Bosnia and Herzegovina": "Bosnia & Herzegovina",
  "Cabo Verde": "Cape Verde",
};

function jsonResponse(body, status = 200, cacheSeconds = 0) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
      "access-control-allow-origin": "*",
    },
  });
}

function normalizeTeam(name) {
  const cleaned = String(name || "").replace(/\s+/g, " ").trim();
  return TEAM_ALIASES[cleaned] || cleaned;
}

function normalizeEspn(payload) {
  return (payload.events || []).map((event) => {
    const competition = event.competitions?.[0] || {};
    const competitors = competition.competitors || [];
    const home = competitors.find((team) => team.homeAway === "home") || {};
    const away = competitors.find((team) => team.homeAway === "away") || {};
    const status = competition.status?.type || event.status?.type || {};
    return {
      provider: "espn",
      id: event.id,
      date: event.date,
      match: event.name || event.shortName || "",
      home: normalizeTeam(home.team?.displayName || home.team?.shortDisplayName),
      away: normalizeTeam(away.team?.displayName || away.team?.shortDisplayName),
      home_score: home.score ?? null,
      away_score: away.score ?? null,
      status: status.description || status.name || "Scheduled",
      completed: Boolean(status.completed),
    };
  }).filter((match) => match.home && match.away);
}

function normalizeFootballData(payload) {
  return (payload.matches || []).map((match) => ({
    provider: "football-data.org",
    id: match.id,
    date: match.utcDate,
    match: `${match.homeTeam?.name || ""} v ${match.awayTeam?.name || ""}`,
    home: normalizeTeam(match.homeTeam?.name),
    away: normalizeTeam(match.awayTeam?.name),
    home_score: match.score?.fullTime?.home ?? match.score?.regularTime?.home ?? null,
    away_score: match.score?.fullTime?.away ?? match.score?.regularTime?.away ?? null,
    status: match.status || "Scheduled",
    completed: ["FINISHED", "AWARDED"].includes(match.status),
  })).filter((match) => match.home && match.away);
}

async function fetchEspn() {
  const response = await fetch(ESPN_SCOREBOARD_URL, {
    headers: { "user-agent": "WorldCup2026Analysis/1.0" },
  });
  if (!response.ok) {
    throw new Error(`ESPN returned ${response.status}`);
  }
  const raw = await response.json();
  return {
    name: "espn_scoreboard",
    status: "live",
    url: ESPN_SCOREBOARD_URL,
    fetched_at: new Date().toISOString(),
    rows: normalizeEspn(raw).length,
    matches: normalizeEspn(raw),
    note: "Live scoreboard API refreshed successfully.",
  };
}

async function fetchFootballData(env) {
  if (!env.FOOTBALL_DATA_TOKEN) {
    return {
      name: "football_data_org",
      status: "not_configured",
      url: FOOTBALL_DATA_MATCHES_URL,
      fetched_at: new Date().toISOString(),
      rows: 0,
      matches: [],
      note: "Optional fallback API. Add FOOTBALL_DATA_TOKEN in Cloudflare to enable it.",
    };
  }
  const response = await fetch(FOOTBALL_DATA_MATCHES_URL, {
    headers: { "X-Auth-Token": env.FOOTBALL_DATA_TOKEN },
  });
  if (!response.ok) {
    throw new Error(`football-data.org returned ${response.status}`);
  }
  const raw = await response.json();
  const matches = normalizeFootballData(raw);
  return {
    name: "football_data_org",
    status: "live",
    url: FOOTBALL_DATA_MATCHES_URL,
    fetched_at: new Date().toISOString(),
    rows: matches.length,
    matches,
    note: "Fallback match API refreshed successfully.",
  };
}

async function liveResults(request, env) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).origin + "/api/live-results-cache");
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const sources = [];
  let primaryMatches = [];
  try {
    const espn = await fetchEspn();
    sources.push({ ...espn, matches: undefined });
    primaryMatches = espn.matches;
  } catch (error) {
    sources.push({
      name: "espn_scoreboard",
      status: "error",
      url: ESPN_SCOREBOARD_URL,
      fetched_at: new Date().toISOString(),
      rows: 0,
      note: error.message,
    });
  }

  try {
    const footballData = await fetchFootballData(env);
    sources.push({ ...footballData, matches: undefined });
    if (!primaryMatches.length && footballData.matches.length) {
      primaryMatches = footballData.matches;
    }
  } catch (error) {
    sources.push({
      name: "football_data_org",
      status: "error",
      url: FOOTBALL_DATA_MATCHES_URL,
      fetched_at: new Date().toISOString(),
      rows: 0,
      note: error.message,
    });
  }

  const response = jsonResponse({
    generated_at: new Date().toISOString(),
    refresh_interval_seconds: LIVE_CACHE_SECONDS,
    matches: primaryMatches,
    sources,
  }, 200, LIVE_CACHE_SECONDS);
  await cache.put(cacheKey, response.clone());
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/live-results") {
      return liveResults(request, env);
    }
    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, generated_at: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  },
};
