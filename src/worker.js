const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const FOOTBALL_DATA_MATCHES_URL = "https://api.football-data.org/v4/competitions/WC/matches";
const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const LIVE_CACHE_SECONDS = 300;
const ASK_AI_CACHE_SECONDS = 21600;
const MAX_AI_REQUEST_BYTES = 12000;
const MAX_AI_QUESTION_CHARS = 280;
const ASK_AI_COOLDOWN_SECONDS = 10;
const ALLOWED_AI_ORIGINS = new Set([
  "https://etwc2026.eetiong96.workers.dev",
]);

const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

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

function isAllowedAiOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_AI_ORIGINS.has(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function securityHeaders() {
  return { ...SECURITY_HEADERS };
}

function withSecurityHeaders(response) {
  const secured = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    secured.headers.set(key, value);
  }
  return secured;
}

function jsonResponse(body, status = 200, cacheSeconds = 0, extraHeaders = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...securityHeaders(),
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
      ...extraHeaders,
    },
  });
}

function aiCorsHeaders(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    "vary": "Origin",
  };
}

function corsPreflight(request) {
  const origin = request.headers.get("origin") || "";
  if (!isAllowedAiOrigin(origin)) {
    return jsonResponse({ error: "Ask AI is only available from this website." }, 403);
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...securityHeaders(),
      ...aiCorsHeaders(origin),
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
    penalties: pickRows(context.penalties, 10, ["t", "rating"]),
  };
}

async function loadStaticDashboardData(request, env) {
  const dataUrl = new URL("/data.json", request.url);
  const response = await env.ASSETS.fetch(new Request(dataUrl));
  if (!response.ok) {
    throw new Error("Dashboard data is unavailable.");
  }
  return response.json();
}

async function buildServerWebsiteContext(request, env) {
  const data = await loadStaticDashboardData(request, env);
  let live = { matches: [], sources: [] };
  try {
    live = await (await liveResults(request, env)).json();
  } catch {
    live = { matches: [], sources: [] };
  }
  const activeKey = `${data.simulation_options?.default_count || data.simulation_count}-${data.simulation_options?.default_seed || data.simulation_seed}`;
  const activeSimulation = data.simulations?.[activeKey] || {};

  return compactWebsiteContext({
    generated_at: data.generated_at,
    simulation: {
      count: data.simulation_options?.default_count || data.simulation_count,
      seed: data.simulation_options?.default_seed || data.simulation_seed,
    },
    sources: [...(data.sources || []), ...(live.sources || [])].map((source) => ({
      n: source.name,
      st: source.status,
      rows: source.rows,
      method: source.update_method || source.note,
    })),
    standings: (data.current_group_tables || []).map((row) => ({
      g: row.group,
      t: row.team,
      p: row.played,
      w: row.won,
      d: row.drawn,
      l: row.lost,
      pts: row.points,
    })),
    live_matches: (live.matches || []).map((match) => ({
      date: match.date,
      h: match.home,
      hs: match.home_score,
      as: match.away_score,
      a: match.away,
      st: match.status,
    })),
    stage_probabilities: (data.simulation_probabilities || activeSimulation.simulation_probabilities || []).map((row) => ({
      t: row.team,
      g: row.group,
      r32: row["Round of 32"],
      qf: row["Quarter-finals"],
      sf: row["Semi-finals"],
      f: row.Final,
      ch: row.Champion,
    })),
    round32: (data.round32_analysis || activeSimulation.round32_analysis || []).map((row) => ({
      m: row.match,
      fx: row.fixture,
      fav: row.favorite,
      p: row.favorite_win_probability,
    })),
    bracket: (data.bracket || activeSimulation.bracket || []).map((row) => ({
      rd: row.round,
      m: row.match,
      a: row.team_a,
      b: row.team_b,
      w: row.winner,
    })),
    team_power: (data.team_strength || []).map((row) => ({
      t: row.team,
      g: row.group,
      s: row.strength_score,
    })),
    penalties: (data.penalties || []).map((row) => ({
      t: row.team,
      rating: row.penalty_shootout_rating,
    })),
  });
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
    `Question: ${question}`,
    `Data: ${JSON.stringify(context)}`,
  ].join("\n");
}

function percent(value) {
  const number = Number(value || 0);
  return `${Math.round(number * 1000) / 10}%`;
}

function teamLabel(row) {
  return row?.t || row?.team || "Unknown team";
}

function localDashboardAnswer(question, context) {
  const q = question.toLowerCase();
  const teams = Array.isArray(context.stage_probabilities) ? context.stage_probabilities : [];
  const groups = Array.isArray(context.standings) ? context.standings : [];
  const teamPower = Array.isArray(context.team_power) ? context.team_power : [];
  const penalties = Array.isArray(context.penalties) ? context.penalties : [];
  const sortedChampion = [...teams].sort((a, b) => Number(b.ch || 0) - Number(a.ch || 0));

  const mentioned = teams.find((row) => q.includes(String(row.t || "").toLowerCase()));
  if (mentioned) {
    return [
      `Based on this dashboard's simulation data, ${mentioned.t} has a ${percent(mentioned.ch)} champion chance.`,
      `Round of 32: ${percent(mentioned.r32)}, quarter-final: ${percent(mentioned.qf)}, semi-final: ${percent(mentioned.sf)}, final: ${percent(mentioned.f)}.`,
      "Caveat: this is from the deployed model data, not live injury or lineup news.",
    ].join("\n");
  }

  if (q.includes("penalt")) {
    const top = [...penalties].sort((a, b) => Number(b.rating || 0) - Number(a.rating || 0)).slice(0, 5);
    return [
      "Best penalty shootout profiles in the dashboard:",
      ...top.map((row, index) => `${index + 1}. ${teamLabel(row)} - rating ${Math.round(Number(row.rating || 0) * 10) / 10}`),
      "Caveat: this is a team-level proxy, not confirmed penalty takers or goalkeeper form.",
    ].join("\n");
  }

  if (q.includes("group") && (q.includes("hard") || q.includes("tough"))) {
    const groupScores = new Map();
    for (const row of teamPower) {
      const group = row.g || "Unknown";
      const current = groupScores.get(group) || { total: 0, count: 0 };
      current.total += Number(row.s || 0);
      current.count += 1;
      groupScores.set(group, current);
    }
    const ranked = [...groupScores.entries()]
      .map(([group, value]) => ({ group, avg: value.count ? value.total / value.count : 0 }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 3);
    return [
      "Hardest groups by average team power:",
      ...ranked.map((row, index) => `${index + 1}. Group ${row.group} - average strength ${Math.round(row.avg * 10) / 10}`),
      "Caveat: this uses the dashboard's strength model, not betting markets.",
    ].join("\n");
  }

  if (q.includes("upset")) {
    const upsetTeams = [...teams]
      .filter((row) => Number(row.qf || 0) >= 0.18 && Number(row.ch || 0) <= 0.08)
      .sort((a, b) => Number(b.qf || 0) - Number(a.qf || 0))
      .slice(0, 5);
    return [
      "Possible upset picks from the dashboard:",
      ...upsetTeams.map((row, index) => `${index + 1}. ${row.t} - quarter-final ${percent(row.qf)}, champion ${percent(row.ch)}`),
      "Caveat: an upset pick means a decent path chance, not that they are favorites.",
    ].join("\n");
  }

  if (q.includes("point") || q.includes("standing") || q.includes("table")) {
    const leaders = [...groups].sort((a, b) => Number(b.pts || 0) - Number(a.pts || 0)).slice(0, 8);
    return [
      "Current table leaders from the dashboard:",
      ...leaders.map((row) => `Group ${row.g}: ${row.t} - ${row.pts} pts, ${row.w}W ${row.d}D ${row.l}L`),
      "Caveat: before matches are played, most teams will show zero points.",
    ].join("\n");
  }

  const top = sortedChampion.slice(0, 5);
  return [
    `Most likely champion in the dashboard: ${top[0]?.t || "not available"} at ${percent(top[0]?.ch)}.`,
    ...top.slice(1).map((row, index) => `${index + 2}. ${row.t} - ${percent(row.ch)}`),
    "Caveat: this is a model simulation answer from the deployed dashboard data.",
  ].join("\n");
}

async function postDeepSeek(env, question, context, model) {
  const response = await fetch(DEEPSEEK_CHAT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
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
    throw new Error(`DeepSeek ${response.status} for ${model}: ${text.slice(0, 180)}`);
  }
  return response.json();
}

async function callDeepSeek(env, question, context) {
  const models = [...new Set([
    env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    "deepseek-chat",
  ])];
  let lastError;
  for (const model of models) {
    try {
      const payload = await postDeepSeek(env, question, context, model);
      return payload.choices?.[0]?.message?.content || "No answer was returned.";
    } catch (error) {
      lastError = error;
      console.error("ask-ai provider failure", error.message);
    }
  }
  throw lastError || new Error("AI provider request failed.");
}

async function askAi(request, env) {
  const origin = request.headers.get("origin") || "";
  if (request.method === "OPTIONS") return corsPreflight(request);
  if (!isAllowedAiOrigin(origin)) {
    return jsonResponse({ error: "Ask AI is only available from this website." }, 403);
  }
  const corsHeaders = aiCorsHeaders(origin);
  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST." }, 405, 0, corsHeaders);
  }
  if (!env.DEEPSEEK_API_KEY) {
    return jsonResponse({ error: "Ask AI is not enabled yet." }, 503, 0, corsHeaders);
  }
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_AI_REQUEST_BYTES) {
    return jsonResponse({ error: "AI request is too large." }, 413, 0, corsHeaders);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400, 0, corsHeaders);
  }
  const question = String(body.question || "").trim();
  if (!question) {
    return jsonResponse({ error: "Please ask a question." }, 400, 0, corsHeaders);
  }
  if (question.length > MAX_AI_QUESTION_CHARS) {
    return jsonResponse({ error: `Question is too long. Keep it under ${MAX_AI_QUESTION_CHARS} characters.` }, 413, 0, corsHeaders);
  }

  const cache = globalThis.caches?.default;
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const rateHash = await hashText(ip);
  const rateKey = new Request(new URL(request.url).origin + `/api/ask-ai-rate/${rateHash}`);
  if (cache && await cache.match(rateKey)) {
    return jsonResponse({ error: `Please wait ${ASK_AI_COOLDOWN_SECONDS} seconds before asking another AI question.` }, 429, 0, corsHeaders);
  }

  let context;
  try {
    context = await buildServerWebsiteContext(request, env);
    const cacheSeed = JSON.stringify({ question: question.toLowerCase(), context, model: env.DEEPSEEK_MODEL || "deepseek-v4-flash" });
    const cacheHash = await hashText(cacheSeed);
    const cacheKey = new Request(new URL(request.url).origin + `/api/ask-ai-cache/${cacheHash}`);
    const cached = cache ? await cache.match(cacheKey) : null;
    if (cache) {
      await cache.put(rateKey, jsonResponse({ ok: true }, 200, ASK_AI_COOLDOWN_SECONDS));
    }
    if (cached) {
      return jsonResponse(await cached.json(), 200, ASK_AI_CACHE_SECONDS, corsHeaders);
    }
    const answer = await callDeepSeek(env, question, context);
    const response = jsonResponse({
      question,
      generated_at: new Date().toISOString(),
      cache_seconds: ASK_AI_CACHE_SECONDS,
      answer,
    }, 200, ASK_AI_CACHE_SECONDS, corsHeaders);
    if (cache) await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    console.error("ask-ai failed", error.message);
    if (context) {
      const fallback = jsonResponse({
        question,
        generated_at: new Date().toISOString(),
        cache_seconds: 0,
        fallback: true,
        answer: localDashboardAnswer(question, context),
      }, 200, 0, corsHeaders);
      return fallback;
    }
    return jsonResponse({ error: "AI is busy right now. Please try again later." }, 502, 0, corsHeaders);
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
    return withSecurityHeaders(await env.ASSETS.fetch(request));
  },
};
