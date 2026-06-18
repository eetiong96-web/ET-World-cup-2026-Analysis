const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const FOOTBALL_DATA_MATCHES_URL = "https://api.football-data.org/v4/competitions/WC/matches";
const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const LIVE_CACHE_SECONDS = 300;
const ASK_AI_CACHE_SECONDS = 21600;
const MAX_AI_REQUEST_BYTES = 30000;
const MAX_AI_QUESTION_CHARS = 1500;
const AI_USAGE_EVENT_LIMIT = 80;

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

function bearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return new URL(request.url).searchParams.get("token") || "";
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

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function parseDeviceFromUserAgent(userAgent) {
  const ua = String(userAgent || "");
  let os = "Unknown";
  let browser = "Unknown";
  let device = "Desktop";
  let model = "";

  if (/iPhone/i.test(ua)) {
    os = "iOS";
    device = "Phone";
    model = "iPhone";
  } else if (/iPad/i.test(ua)) {
    os = "iPadOS";
    device = "Tablet";
    model = "iPad";
  } else if (/Android/i.test(ua)) {
    os = "Android";
    device = /Mobile/i.test(ua) ? "Phone" : "Tablet";
    const match = ua.match(/Android [^;]+;\s*([^;)]+)\s+Build/i);
    model = match?.[1]?.trim() || "Android device";
  } else if (/Windows/i.test(ua)) {
    os = "Windows";
  } else if (/Mac OS X/i.test(ua)) {
    os = "macOS";
  }

  if (/Edg\//i.test(ua)) browser = "Edge";
  else if (/Chrome\//i.test(ua) && !/Chromium/i.test(ua)) browser = "Chrome";
  else if (/Firefox\//i.test(ua)) browser = "Firefox";
  else if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) browser = "Safari";

  return { os, browser, device, model };
}

function deviceInfo(request, bodyDevice = {}) {
  const ua = request.headers.get("user-agent") || "";
  const parsed = parseDeviceFromUserAgent(ua);
  const clientModel = request.headers.get("sec-ch-ua-model")?.replaceAll("\"", "") || "";
  const hintedModel = String(bodyDevice.model || clientModel || "").trim();
  const hintedPlatform = String(bodyDevice.platform || "").trim();
  const hintedMobile = bodyDevice.mobile === true;
  return {
    browser: String(bodyDevice.browser || parsed.browser).slice(0, 80),
    os: String(hintedPlatform || parsed.os).slice(0, 80),
    device: hintedMobile ? "Phone" : parsed.device,
    model: String(hintedModel || parsed.model || parsed.device).slice(0, 120),
    user_agent_short: ua.slice(0, 180),
  };
}

async function recordAiUsage(request, env, detail) {
  if (!env.AI_USAGE) return;
  const now = new Date().toISOString();
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const ua = request.headers.get("user-agent") || "";
  const visitorHash = await hashText(`${ip}|${ua}`);
  const key = `ai-usage:${visitorHash}`;
  const existing = await env.AI_USAGE.get(key, "json").catch(() => null);
  const current = existing || {
    visitor: visitorHash.slice(0, 16),
    first_seen: now,
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    estimated_cost_usd: 0,
  };
  const inputTokens = Number(detail.usage?.prompt_tokens || detail.estimated_input_tokens || 0);
  const outputTokens = Number(detail.usage?.completion_tokens || detail.estimated_output_tokens || 0);
  const totalTokens = Number(detail.usage?.total_tokens || inputTokens + outputTokens);
  const inputCost = inputTokens * 0.435 / 1000000;
  const outputCost = outputTokens * 0.87 / 1000000;

  current.requests += 1;
  current.last_seen = now;
  current.country = request.cf?.country || "unknown";
  current.city = request.cf?.city || "";
  current.device = detail.device;
  current.last_question = String(detail.question || "").slice(0, 160);
  current.model = detail.model || "deepseek-v4-pro";
  current.input_tokens += inputTokens;
  current.output_tokens += outputTokens;
  current.total_tokens += totalTokens;
  current.estimated_cost_usd = Number((Number(current.estimated_cost_usd || 0) + inputCost + outputCost).toFixed(6));
  await env.AI_USAGE.put(key, JSON.stringify(current));

  const eventKey = `ai-event:${Date.now()}:${visitorHash.slice(0, 12)}`;
  await env.AI_USAGE.put(eventKey, JSON.stringify({
    at: now,
    visitor: current.visitor,
    country: current.country,
    city: current.city,
    device: current.device,
    model: current.model,
    question: current.last_question,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens,
    estimated_cost_usd: Number((inputCost + outputCost).toFixed(6)),
  }), { expirationTtl: 60 * 60 * 24 * 14 });
}

async function aiUsage(request, env) {
  if (!env.ADMIN_TOKEN || bearerToken(request) !== env.ADMIN_TOKEN) {
    return jsonResponse({ error: "Admin token required." }, 401);
  }
  if (!env.AI_USAGE) {
    return jsonResponse({ error: "AI_USAGE KV binding is not configured." }, 503);
  }
  const usersList = await env.AI_USAGE.list({ prefix: "ai-usage:", limit: 1000 });
  const eventList = await env.AI_USAGE.list({ prefix: "ai-event:", limit: AI_USAGE_EVENT_LIMIT });
  const users = (await Promise.all(usersList.keys.map((item) => env.AI_USAGE.get(item.name, "json"))))
    .filter(Boolean)
    .sort((a, b) => Number(b.estimated_cost_usd || 0) - Number(a.estimated_cost_usd || 0));
  const events = (await Promise.all(eventList.keys.map((item) => env.AI_USAGE.get(item.name, "json"))))
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const totals = users.reduce((out, row) => {
    out.requests += Number(row.requests || 0);
    out.input_tokens += Number(row.input_tokens || 0);
    out.output_tokens += Number(row.output_tokens || 0);
    out.total_tokens += Number(row.total_tokens || 0);
    out.estimated_cost_usd += Number(row.estimated_cost_usd || 0);
    return out;
  }, { requests: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 });
  totals.estimated_cost_usd = Number(totals.estimated_cost_usd.toFixed(6));
  return jsonResponse({ generated_at: new Date().toISOString(), totals, users, events });
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
  const prompt = buildDeepSeekPrompt(question, context);
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
        { role: "user", content: prompt },
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
  return {
    answer: payload.choices?.[0]?.message?.content || "No answer was returned.",
    usage: payload.usage || {
      prompt_tokens: estimateTokens(prompt),
      completion_tokens: 520,
      total_tokens: estimateTokens(prompt) + 520,
    },
    model: payload.model || env.DEEPSEEK_MODEL || "deepseek-v4-flash",
  };
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
  const context = compactWebsiteContext(body.context);
  const cacheSeed = JSON.stringify({ question: question.toLowerCase(), context, model: env.DEEPSEEK_MODEL || "deepseek-v4-flash" });
  const cacheHash = await hashText(cacheSeed);
  const cacheKey = new Request(new URL(request.url).origin + `/api/ask-ai-cache/${cacheHash}`);
  const cached = cache ? await cache.match(cacheKey) : null;
  if (cached) return cached;

  try {
    const result = await callDeepSeek(env, question, context);
    await recordAiUsage(request, env, {
      question,
      model: result.model,
      usage: result.usage,
      device: deviceInfo(request, body.device || {}),
    });
    const response = jsonResponse({
      question,
      generated_at: new Date().toISOString(),
      cache_seconds: ASK_AI_CACHE_SECONDS,
      answer: result.answer,
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
    if (url.pathname === "/api/ai-usage") {
      return aiUsage(request, env);
    }
    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, generated_at: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  },
};
