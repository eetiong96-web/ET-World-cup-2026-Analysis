const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const FOOTBALL_DATA_MATCHES_URL = "https://api.football-data.org/v4/competitions/WC/matches";
const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions";
const LIVE_CACHE_SECONDS = 300;
const ASK_AI_CACHE_SECONDS = 21600;
const MAX_AI_REQUEST_BYTES = 30000;
const MAX_AI_QUESTION_CHARS = 1500;
const ASK_AI_MAX_OUTPUT_TOKENS = 900;
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

function htmlResponse(html, status = 200) {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char]));
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-SG");
}

function formatCost(value) {
  return `$${Number(value || 0).toFixed(5)}`;
}

function formatSgt(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).replace(",", "") + " SGT";
}

function bearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return new URL(request.url).searchParams.get("token") || "";
}

function usageStore(env) {
  return env.AI_USAGE || env.USAGE_KV;
}

function adminToken(env) {
  return env.ADMIN_TOKEN || env.ADMIN_PIN;
}

function deepseekModel(env) {
  return env.DEEPSEEK_MODEL || "deepseek-v4-pro";
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
  const store = usageStore(env);
  if (!store) return;
  const now = new Date().toISOString();
  const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "local";
  const ua = request.headers.get("user-agent") || "";
  const visitorHash = await hashText(`${ip}|${ua}`);
  const key = `ai-usage:${visitorHash}`;
  const existing = await store.get(key, "json").catch(() => null);
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
  await store.put(key, JSON.stringify(current));

  const eventKey = `ai-event:${Date.now()}:${visitorHash.slice(0, 12)}`;
  await store.put(eventKey, JSON.stringify({
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
  const result = await aiUsagePayload(request, env);
  const url = new URL(request.url);
  if (url.searchParams.get("format") === "json") {
    return jsonResponse(result.body, result.status);
  }
  if (result.status !== 200) {
    return htmlResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Usage Admin</title></head><body><h1>Usage Admin</h1><p>${escapeHtml(result.body.error)}</p></body></html>`, result.status);
  }
  return htmlResponse(usageDashboardHtml(result.body, request));
}

async function aiUsagePayload(request, env) {
  const token = adminToken(env);
  const store = usageStore(env);
  if (!token || bearerToken(request) !== token) {
    return { status: 401, body: { error: "Admin token required." } };
  }
  if (!store) {
    return { status: 503, body: { error: "Usage KV binding is not configured." } };
  }
  const usersList = await store.list({ prefix: "ai-usage:", limit: 1000 });
  const eventList = await store.list({ prefix: "ai-event:", limit: AI_USAGE_EVENT_LIMIT });
  const users = (await Promise.all(usersList.keys.map((item) => store.get(item.name, "json"))))
    .filter(Boolean)
    .sort((a, b) => Number(b.estimated_cost_usd || 0) - Number(a.estimated_cost_usd || 0));
  const events = (await Promise.all(eventList.keys.map((item) => store.get(item.name, "json"))))
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
  return { status: 200, body: { generated_at: new Date().toISOString(), totals, users, events } };
}

function deviceLabel(device = {}) {
  return [device.model, device.os, device.browser].filter(Boolean).join(" / ") || "-";
}

function usageDashboardHtml(payload, request) {
  const token = encodeURIComponent(bearerToken(request));
  const users = payload.users || [];
  const events = payload.events || [];
  const totals = payload.totals || {};
  const deviceRows = users.map((user) => {
    const device = user.device || {};
    return `<tr>
      <td>${escapeHtml(device.model || device.device || "-")}</td>
      <td>${escapeHtml(user.country || "-")}${user.city ? ` / ${escapeHtml(user.city)}` : ""}</td>
      <td>${escapeHtml(device.os || "-")}</td>
      <td>${escapeHtml(device.browser || "-")}</td>
      <td>${escapeHtml(user.visitor || "-")}</td>
      <td class="num">${formatNumber(user.requests)}</td>
      <td class="num">${formatNumber(user.total_tokens)}</td>
      <td class="num">${formatCost(user.estimated_cost_usd)}</td>
      <td>${formatSgt(user.last_seen)}</td>
    </tr>`;
  }).join("") || `<tr><td colspan="9" class="empty">No Ask AI usage recorded yet.</td></tr>`;
  const eventRows = events.map((event) => `<tr>
      <td>${formatSgt(event.at)}</td>
      <td>${escapeHtml(event.country || "-")}${event.city ? ` / ${escapeHtml(event.city)}` : ""}</td>
      <td>${escapeHtml(event.model || "-")}</td>
      <td>${escapeHtml(deviceLabel(event.device))}</td>
      <td>${escapeHtml(event.question || "-")}</td>
      <td class="num">${formatNumber(event.input_tokens)}</td>
      <td class="num">${formatNumber(event.output_tokens)}</td>
      <td class="num">${formatNumber(event.total_tokens)}</td>
      <td class="num">${formatCost(event.estimated_cost_usd)}</td>
    </tr>`).join("") || `<tr><td colspan="9" class="empty">No recent calls yet.</td></tr>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>World Cup Ask AI Usage</title>
  <style>
    :root { color-scheme: light; --bg:#f4f7fb; --card:#fff; --text:#101827; --muted:#637187; --line:#dbe5f1; --blue:#2457a6; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 32px; background: var(--bg); color: var(--text); font: 18px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    h1 { margin: 0 0 12px; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1.05; }
    h2 { margin: 34px 0 12px; font-size: 1.45rem; }
    a { color: var(--blue); font-weight: 800; text-decoration: none; }
    .muted { color: var(--muted); margin: 0 0 24px; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: start; flex-wrap: wrap; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; }
    .button { border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; background: #fff; box-shadow: 0 8px 22px rgba(16,24,39,.06); }
    .cards { display: grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap: 14px; margin: 28px 0; }
    .card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 14px 30px rgba(16,24,39,.07); }
    .card span { display:block; color: var(--muted); font-size: 1rem; margin-bottom: 8px; }
    .card strong { display:block; font-size: 2rem; line-height: 1; }
    .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: #fff; box-shadow: 0 14px 30px rgba(16,24,39,.06); }
    table { width: 100%; min-width: 980px; border-collapse: collapse; }
    th, td { padding: 13px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    th { background: #eaf0f7; color: #5d6d82; font-weight: 900; }
    tr:last-child td { border-bottom: 0; }
    .num { text-align: right; white-space: nowrap; }
    .empty { color: var(--muted); text-align: center; padding: 26px; }
    .note { color: var(--muted); margin-top: 8px; max-width: 1100px; }
    @media (max-width: 820px) {
      body { padding: 18px; font-size: 17px; }
      .cards { grid-template-columns: 1fr 1fr; }
      .card strong { font-size: 1.55rem; }
    }
    @media (max-width: 520px) { .cards { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="topbar">
    <div>
      <h1>World Cup Ask AI Usage</h1>
      <p class="muted">Latest ${AI_USAGE_EVENT_LIMIT} calls. Generated ${formatSgt(payload.generated_at)}.</p>
    </div>
    <div class="actions">
      <a class="button" href="/api/ai-usage?token=${token}&format=json">Open JSON</a>
      <a class="button" href="/">Back to Dashboard</a>
    </div>
  </div>
  <section class="cards">
    <div class="card"><span>Calls</span><strong>${formatNumber(totals.requests)}</strong></div>
    <div class="card"><span>Total Tokens</span><strong>${formatNumber(totals.total_tokens)}</strong></div>
    <div class="card"><span>Output Tokens</span><strong>${formatNumber(totals.output_tokens)}</strong></div>
    <div class="card"><span>Est. Cost</span><strong>${formatCost(totals.estimated_cost_usd)}</strong></div>
  </section>
  <h2>By Device</h2>
  <p class="note">Browsers often hide exact phone or laptop model for privacy. Android may show a model number; iPhone normally only shows iPhone.</p>
  <div class="table-wrap"><table>
    <thead><tr><th>Phone / Device</th><th>Location</th><th>OS</th><th>Browser</th><th>Visitor</th><th>Calls</th><th>Tokens</th><th>Cost</th><th>Last seen</th></tr></thead>
    <tbody>${deviceRows}</tbody>
  </table></div>
  <h2>Recent Calls</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Time</th><th>Location</th><th>Model</th><th>Device</th><th>Question</th><th>Input</th><th>Output</th><th>Tokens</th><th>Cost</th></tr></thead>
    <tbody>${eventRows}</tbody>
  </table></div>
</body>
</html>`;
}

async function aiUsageDashboard(request, env) {
  const result = await aiUsagePayload(request, env);
  if (result.status !== 200) {
    return htmlResponse(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Usage Admin</title></head><body><h1>Usage Admin</h1><p>${escapeHtml(result.body.error)}</p></body></html>`, result.status);
  }
  return htmlResponse(usageDashboardHtml(result.body, request));
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
      model: deepseekModel(env),
      messages: [
        {
          role: "system",
          content: "You answer questions about a World Cup dashboard using only the provided JSON context. If the answer is outside the context, say so.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.35,
      max_tokens: ASK_AI_MAX_OUTPUT_TOKENS,
      stream: false,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DeepSeek returned ${response.status}: ${text.slice(0, 180)}`);
  }
  const payload = await response.json();
  const choice = payload.choices?.[0] || {};
  return {
    answer: choice.message?.content || "No answer was returned.",
    finish_reason: choice.finish_reason || "",
    usage: payload.usage || {
      prompt_tokens: estimateTokens(prompt),
      completion_tokens: ASK_AI_MAX_OUTPUT_TOKENS,
      total_tokens: estimateTokens(prompt) + ASK_AI_MAX_OUTPUT_TOKENS,
    },
    model: payload.model || deepseekModel(env),
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
  const cacheSeed = JSON.stringify({ question: question.toLowerCase(), context, model: deepseekModel(env) });
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
      finish_reason: result.finish_reason,
      truncated: result.finish_reason === "length",
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
    if (url.pathname === "/admin/usage") {
      return aiUsageDashboard(request, env);
    }
    if (url.pathname === "/api/health") {
      return jsonResponse({ ok: true, generated_at: new Date().toISOString() });
    }
    return env.ASSETS.fetch(request);
  },
};
