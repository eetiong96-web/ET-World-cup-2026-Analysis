const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const FOOTBALL_DATA_MATCHES_URL = "https://api.football-data.org/v4/competitions/WC/matches";
const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const LIVE_CACHE_SECONDS = 300;
const ASK_AI_CACHE_SECONDS = 21600;
const MAX_AI_REQUEST_BYTES = 30000;
const MAX_AI_QUESTION_CHARS = 1500;
const ASK_AI_COOLDOWN_SECONDS = 10;

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

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
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
  const cache = globalThis.caches?.default;
  const cacheKey = new Request(new URL(request.url).origin + "/api/live-results-cache");
  const cached = cache ? await cache.match(cacheKey) : null;
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
  if (cache) await cache.put(cacheKey, response.clone());
  return response;
}

async function hashText(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function compactWebsiteContext(context = {}) {
  const pickRows = (rows, limit, keys) => (Array.isArray(rows) ? rows.slice(0, limit).map((row) => {
    const out = {};
    for (const key of keys) out[key] = row?.[key];
    return out;
  }) : []);

  return {
    generated_at: String(context.generated_at || "").slice(0, 40),
    simulation: context.simulation || {},
    sources: pickRows(context.sources, 10, ["n", "st", "rows", "method"]),
    standings: pickRows(context.standings, 60, ["g", "t", "p", "w", "d", "l", "pts"]),
    live_matches: pickRows(context.live_matches, 8, ["date", "h", "hs", "as", "a", "st"]),
    stage_probabilities: pickRows(context.stage_probabilities, 60, ["t", "g", "r32", "qf", "sf", "f", "ch"]),
    round32: pickRows(context.round32, 10, ["m", "fx", "fav", "p"]),
    bracket: pickRows(context.bracket, 16, ["rd", "m", "a", "b", "w"]),
    team_power: pickRows(context.team_power, 16, ["t", "g", "s"]),
    goal_matches: pickRows(context.goal_matches, 72, ["g", "m", "h", "hg", "a", "ag", "tg"]),
    goal_totals: pickRows(context.goal_totals, 48, ["t", "g", "gf", "ga", "gd"]),
    penalties: pickRows(context.penalties, 10, ["t", "rating"]),
  };
}

function buildDeepSeekPrompt(question, context) {
  return [
    "You are an analytical football commentator for a World Cup 2026 dashboard.",
    "Answer ONLY from the supplied website data. Do not use outside knowledge or live internet.",
    "If the website data does not contain the answer, say that the dashboard does not have enough data.",
    "Do not invent injuries, team news, lineups, official results, or private information.",
    "Use plain language for casual football fans.",
    "Keep it concise: direct answer, 3-5 bullets when useful, and one caveat if needed.",
    "Compact field hints: t/team, g/group, p/position or probability depending on section, pts/points, ch/champion probability, qf/quarter-final probability.",
    "Goal field hints: h/home team, a/away team, hg/home expected goals, ag/away expected goals, tg/total expected goals, gf/team expected goals for, ga/team expected goals against, gd/expected goal difference.",
    "For goal questions, answer with expected goals for each team and total expected goals. Make clear these are model estimates, not guaranteed scores.",
    `Question: ${question}`,
    `Data: ${JSON.stringify(context)}`,
  ].join("\n");
}

async function callDeepSeek(env, question, context) {
  const response = await fetch(DEEPSEEK_CHAT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.DEEPSEEK_MODEL || "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content: "You answer questions about a World Cup dashboard using only the provided JSON context. If the answer is outside the context, say so.",
        },
        { role: "user", content: buildDeepSeekPrompt(question, context) },
      ],
      temperature: 0.35,
      max_tokens: 520,
      stream: false,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek returned ${response.status}: ${text.slice(0, 180)}`);
  }
  const payload = await response.json();
  return payload.choices?.[0]?.message?.content || "No answer was returned.";
}

async function askAi(request, env) {
  if (request.method === "OPTIONS") return corsPreflight();
  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST." }, 405);
  }
  if (!env.DEEPSEEK_API_KEY) {
    return jsonResponse({ error: "Ask AI is not enabled. Add DEEPSEEK_API_KEY in Cloudflare." }, 503);
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_AI_REQUEST_BYTES) {
    return jsonResponse({ error: "AI request is too large." }, 413);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  const question = String(body.question || "").trim();
  if (!question) {
    return jsonResponse({ error: "Please ask a question." }, 400);
  }
  if (question.length > MAX_AI_QUESTION_CHARS) {
    return jsonResponse({ error: `Question is too long. Keep it under ${MAX_AI_QUESTION_CHARS} characters.` }, 413);
  }

  const cache = globalThis.caches?.default;
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const rateHash = await hashText(ip);
  const rateKey = new Request(new URL(request.url).origin + `/api/ask-ai-rate/${rateHash}`);
  if (cache && await cache.match(rateKey)) {
    return jsonResponse({ error: `Please wait ${ASK_AI_COOLDOWN_SECONDS} seconds before asking another AI question.` }, 429);
  }

  const context = compactWebsiteContext(body.context);
  const cacheSeed = JSON.stringify({ question: question.toLowerCase(), context, model: env.DEEPSEEK_MODEL || "deepseek-v4-flash" });
  const cacheHash = await hashText(cacheSeed);
  const cacheKey = new Request(new URL(request.url).origin + `/api/ask-ai-cache/${cacheHash}`);
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return cached;

  try {
    if (cache) {
      await cache.put(rateKey, jsonResponse({ ok: true }, 200, ASK_AI_COOLDOWN_SECONDS));
    }
    const answer = await callDeepSeek(env, question, context);
    const response = jsonResponse({
      question,
      generated_at: new Date().toISOString(),
      cache_seconds: ASK_AI_CACHE_SECONDS,
      answer,
    }, 200, ASK_AI_CACHE_SECONDS);
    if (cache) await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    return jsonResponse({ error: error.message }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/live-results") {
      return liveResults(request, env);
    }
    if (url.pathname === "/api/ask-ai") {
      return askAi(request, env);
    }
    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, generated_at: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  },
};
