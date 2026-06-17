const pages = [
  "Data Sources and Refresh Status",
  "Team Power Ratings",
  "Group Stage Simulator",
  "Goal Group Stage Simulator",
  "Group Qualification Visual",
  "Animated Country Path",
  "Penalty Shootout Estimator",
  "Ask AI",
  "Champion Odds",
  "Methodology and Caveats",
];

const AI_COOLDOWN_MS = 10000;

const state = { page: pages[0], data: null, live: null, simCount: null, simSeed: null, refreshTimer: null, liveRefreshPending: false, lastLiveRefreshCheck: 0, aiCooldownUntil: 0, aiLastResult: null, countryPathSort: "az", countryPathTeam: null };

function loadingSkeleton() {
  return `<div class="skeleton-page"><div class="skeleton-line title"></div><div class="skeleton-line subtitle"></div><div class="skeleton-grid">${Array.from({ length: 6 }, () => `<div class="skeleton-card"><div></div><span></span><span></span><span></span></div>`).join("")}</div></div>`;
}

const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
const pct1 = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;
const num = (v, d = 1) => Number(v || 0).toFixed(d);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function nextFromTimestamp(timestamp, intervalMs) {
  const builtAt = new Date(timestamp).getTime();
  if (!Number.isFinite(builtAt)) return null;
  return builtAt + intervalMs;
}

function formatSgtDate(timestamp) {
  if (!timestamp) return "Date/time TBD (SGT)";
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "Date/time TBD (SGT)";
  return `${date.toLocaleString("en-SG", {
    timeZone: "Asia/Singapore",
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })} SGT`;
}

function cadenceMinutes() {
  return Number(state.data?.refresh_cadences?.live_results_minutes || 5);
}

function modelRefreshHours() {
  return Number(state.data?.refresh_cadences?.model_refresh_hours || 1);
}

function sourceRefreshMs(source) {
  if (["espn_scoreboard", "football_data_org"].includes(source.name)) return cadenceMinutes() * 60 * 1000;
  if (["transfermarkt_values", "eur_sgd_fx"].includes(source.name)) return Number(state.data?.refresh_cadences?.transfermarkt_values_hours || 1) * 60 * 60 * 1000;
  return 0;
}

function modelNextRefreshAt() {
  return nextFromTimestamp(state.data?.generated_at, modelRefreshHours() * 60 * 60 * 1000);
}

function modelCountdownText() {
  const nextAt = modelNextRefreshAt();
  if (!nextAt) return `${modelRefreshHours()}h schedule`;
  const remaining = nextAt - Date.now();
  return remaining > 0 ? formatDuration(remaining) : "waiting for next build";
}

function countdownBadge(source) {
  const refreshMs = sourceRefreshMs(source);
  if (!refreshMs || !source.fetched_at) return "Reference";
  const nextAt = nextFromTimestamp(source.fetched_at, refreshMs);
  if (!nextAt) return "Timer unavailable";
  return `<span class="countdown-badge" data-countdown="${nextAt}"></span>`;
}

function updateCountdownBadges() {
  document.querySelectorAll("[data-countdown]").forEach((el) => {
    const nextAt = Number(el.dataset.countdown);
    const remaining = nextAt - Date.now();
    el.textContent = remaining > 0 ? formatDuration(remaining) : "checking now";
    el.classList.toggle("checking", remaining <= 0);
  });
}

function updateAiCooldownTimer() {
  const timer = document.getElementById("ai-cooldown-timer");
  const button = document.getElementById("ask-ai-submit");
  if (!timer && !button) return;
  const remaining = state.aiCooldownUntil - Date.now();
  if (remaining > 0) {
    if (timer) {
      timer.textContent = `Next question in ${formatDuration(remaining)}`;
      timer.classList.add("active");
    }
    if (button) {
      button.disabled = true;
      button.textContent = `Wait ${formatDuration(remaining)}`;
    }
  } else {
    if (timer) {
      timer.textContent = "Ready to ask";
      timer.classList.remove("active");
    }
    if (button) {
      button.disabled = false;
      button.textContent = "Ask AI";
    }
  }
}

function updateRefreshTimer() {
  const el = document.getElementById("refresh-meta");
  if (!el || !state.data || !state.live) return;
  const nextAt = nextFromTimestamp(state.live.generated_at, cadenceMinutes() * 60 * 1000);
  if (!nextAt) {
    el.textContent = "Refresh timer unavailable";
    return;
  }
  const remaining = nextAt - Date.now();
  if (remaining > 0) {
    const modelText = modelCountdownText();
    el.textContent = `Live match API refresh in ${formatDuration(remaining)} | model and predictions refresh in ${modelText}`;
    el.classList.remove("checking");
    updateCountdownBadges();
    updateAiCooldownTimer();
    return;
  }
  el.textContent = "Checking live match API...";
  el.classList.add("checking");
  updateCountdownBadges();
  updateAiCooldownTimer();
  const enoughTimePassed = Date.now() - state.lastLiveRefreshCheck > 15000;
  if (!state.liveRefreshPending && enoughTimePassed) {
    loadLiveResults({ silent: true });
  }
}

function startRefreshTimer() {
  if (state.refreshTimer) window.clearInterval(state.refreshTimer);
  updateRefreshTimer();
  state.refreshTimer = window.setInterval(updateRefreshTimer, 1000);
}

function table(rows, columns) {
  if (!rows || rows.length === 0) return `<p class="muted">No rows available.</p>`;
  return `<div class="table-wrap"><table><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => {
    const value = c.format ? c.format(r[c.key], r) : r[c.key];
    return `<td>${c.html ? value : esc(value)}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function sgdValueMillions(value) {
  const rate = Number(state.data?.currency?.eur_to_sgd || 1.46);
  return Number(value || 0) * rate;
}

function sgdMillions(value) {
  return `SGD ${sgdValueMillions(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}m`;
}

function topBar(rows, labelKey, valueKey, limit = 16) {
  return rows.slice(0, limit).map((r) => `<div class="qual-row"><strong>${esc(r[labelKey])}</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Number(r[valueKey]) * 100)}%"></div></div><span>${pct1(r[valueKey])}</span></div>`).join("");
}

function setMobileNav(open) {
  document.body.classList.toggle("nav-open", open);
  const toggle = document.getElementById("menu-toggle");
  if (toggle) toggle.setAttribute("aria-expanded", open ? "true" : "false");
}

function renderNav() {
  const toggle = document.getElementById("menu-toggle");
  document.getElementById("nav").innerHTML = pages.map((p) => `<button class="nav-btn ${state.page === p ? "active" : ""}" data-page="${esc(p)}">${esc(p)}</button>`).join("");
  if (toggle && !toggle.dataset.bound) {
    toggle.dataset.bound = "true";
    toggle.addEventListener("click", () => setMobileNav(!document.body.classList.contains("nav-open")));
  }
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => {
    state.page = btn.dataset.page;
    setMobileNav(false);
    render();
  }));
}

document.addEventListener("click", (event) => {
  if (!document.body.classList.contains("nav-open")) return;
  if (event.target.closest(".sidebar")) return;
  setMobileNav(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMobileNav(false);
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 1180) setMobileNav(false);
});

function activeSimulation() {
  const d = state.data;
  const key = `${state.simCount}-${state.simSeed}`;
  return d.simulations?.[key] || {
    count: d.simulation_count,
    seed: d.simulation_seed,
    simulation_probabilities: d.simulation_probabilities,
    bracket: d.bracket,
    round32_analysis: d.round32_analysis,
  };
}

function mergedSources(d) {
  const liveByName = new Map((state.live?.sources || []).map((source) => [source.name, source]));
  const rows = d.sources.map((source) => ({ ...source, ...(liveByName.get(source.name) || {}) }));
  for (const source of state.live?.sources || []) {
    if (!rows.some((row) => row.name === source.name)) rows.push(source);
  }
  return rows.map((source) => ({
    ...source,
    update_method: ["transfermarkt_values", "eur_sgd_fx"].includes(source.name)
      ? `Build refresh, ${modelRefreshHours()}h`
      : ["espn_scoreboard", "football_data_org"].includes(source.name)
        ? "Live API, 5m"
        : source.name === "openfootball_worldcup" || source.name === "groups_2026"
          ? "GitHub raw/build"
          : source.status === "reference"
            ? "Reference only"
            : "Build fetch/cache",
    refresh_timer: countdownBadge(source),
  }));
}

function currentStandings(d) {
  const teamToGroup = new Map(d.groups.map((row) => [row.team, row.group]));
  const baseRows = d.current_group_tables?.length
    ? d.current_group_tables
    : d.groups.map((row) => ({ group: row.group, team: row.team, played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0, goal_difference: 0, points: 0 }));
  const table = new Map(baseRows.map((row) => [row.team, { ...row }]));
  const knownCompleted = new Set((d.live_results || [])
    .filter((match) => match.completed)
    .map((match) => `${match.date || ""}|${match.home}|${match.away}`));
  const completed = (state.live?.matches || []).filter((match) =>
    match.completed
    && teamToGroup.has(match.home)
    && teamToGroup.has(match.away)
    && !knownCompleted.has(`${match.date || ""}|${match.home}|${match.away}`)
  );
  completed.forEach((match) => {
    const home = table.get(match.home);
    const away = table.get(match.away);
    const homeScore = Number(match.home_score);
    const awayScore = Number(match.away_score);
    if (!home || !away || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
    home.played += 1;
    away.played += 1;
    home.goals_for += homeScore;
    home.goals_against += awayScore;
    away.goals_for += awayScore;
    away.goals_against += homeScore;
    if (homeScore > awayScore) {
      home.won += 1;
      home.points += 3;
      away.lost += 1;
    } else if (awayScore > homeScore) {
      away.won += 1;
      away.points += 3;
      home.lost += 1;
    } else {
      home.drawn += 1;
      away.drawn += 1;
      home.points += 1;
      away.points += 1;
    }
  });
  return [...table.values()].map((row) => ({ ...row, goal_difference: row.goals_for - row.goals_against }));
}

function groupTables(d) {
  const groups = [...new Set(d.groups.map((r) => r.group))].sort();
  const standings = currentStandings(d);
  return `<div class="group-table-grid">${groups.map((group) => {
    const rows = standings
      .filter((r) => r.group === group)
      .sort((a, b) => Number(b.points) - Number(a.points) || Number(b.goal_difference) - Number(a.goal_difference) || Number(b.goals_for) - Number(a.goals_for) || a.team.localeCompare(b.team));
    return `<section class="group-table-card"><h4>Group ${esc(group)}</h4><div class="mini-standings"><div class="mini-standing-head"><span>Team</span><span>P</span><span>W</span><span>D</span><span>L</span><span>Pts</span></div>${rows.map((row, index) => `<div class="mini-standing-row"><div class="mini-team"><span>${index + 1}</span><strong>${esc(row.team)}</strong></div><span>${esc(row.played)}</span><span>${esc(row.won)}</span><span>${esc(row.drawn)}</span><span>${esc(row.lost)}</span><strong>${esc(row.points)}</strong></div>`).join("")}</div></section>`;
  }).join("")}</div>`;
}

function knockoutSlotRows(count) {
  return Array.from({ length: count }, (_, index) => ({ id: index + 1, teamA: "TBD", teamB: "TBD", date: "TBD" }));
}

const knockoutSchedule = {
  73: { date: "2026-06-28T19:00:00Z", venue: "Inglewood" },
  74: { date: "2026-06-29T20:30:00Z", venue: "Foxborough" },
  75: { date: "2026-06-30T01:00:00Z", venue: "Guadalupe" },
  76: { date: "2026-06-29T17:00:00Z", venue: "Houston" },
  77: { date: "2026-06-30T21:00:00Z", venue: "East Rutherford" },
  78: { date: "2026-06-30T17:00:00Z", venue: "Arlington" },
  79: { date: "2026-07-01T01:00:00Z", venue: "Mexico City" },
  80: { date: "2026-07-01T16:00:00Z", venue: "Atlanta" },
  81: { date: "2026-07-02T00:00:00Z", venue: "Santa Clara" },
  82: { date: "2026-07-01T20:00:00Z", venue: "Seattle" },
  83: { date: "2026-07-02T23:00:00Z", venue: "Toronto" },
  84: { date: "2026-07-02T19:00:00Z", venue: "Inglewood" },
  85: { date: "2026-07-03T03:00:00Z", venue: "Vancouver" },
  86: { date: "2026-07-03T22:00:00Z", venue: "Miami Gardens" },
  87: { date: "2026-07-04T01:30:00Z", venue: "Kansas City" },
  88: { date: "2026-07-03T18:00:00Z", venue: "Arlington" },
  89: { date: "2026-07-04T21:00:00Z", venue: "Philadelphia" },
  90: { date: "2026-07-04T17:00:00Z", venue: "Houston" },
  91: { date: "2026-07-05T20:00:00Z", venue: "East Rutherford" },
  92: { date: "2026-07-06T00:00:00Z", venue: "Mexico City" },
  93: { date: "2026-07-06T19:00:00Z", venue: "Arlington" },
  94: { date: "2026-07-07T00:00:00Z", venue: "Seattle" },
  95: { date: "2026-07-07T16:00:00Z", venue: "Atlanta" },
  96: { date: "2026-07-07T20:00:00Z", venue: "Vancouver" },
  97: { date: "2026-07-09T20:00:00Z", venue: "Foxborough" },
  98: { date: "2026-07-10T19:00:00Z", venue: "Inglewood" },
  99: { date: "2026-07-11T21:00:00Z", venue: "Miami Gardens" },
  100: { date: "2026-07-12T01:00:00Z", venue: "Kansas City" },
  101: { date: "2026-07-14T19:00:00Z", venue: "Arlington" },
  102: { date: "2026-07-15T19:00:00Z", venue: "Atlanta" },
  103: { date: "2026-07-18T21:00:00Z", venue: "Miami Gardens" },
  104: { date: "2026-07-19T19:00:00Z", venue: "East Rutherford" },
};

function knockoutBracket(d) {
  const liveRows = liveKnockoutRows(d);
  const liveByMatch = new Map(liveRows.map((match, index) => [match.match || `live-${index + 1}`, match]));
  const rounds = [
    { title: "Round of 32", count: 16, start: 73 },
    { title: "Round of 16", count: 8, start: 89 },
    { title: "Quarter-finals", count: 4, start: 97 },
    { title: "Semi-finals", count: 2, start: 101 },
    { title: "Third Place", count: 1, start: 103 },
    { title: "Final", count: 1, start: 104 },
  ];
  return `<section class="bracket-shell"><div class="bracket-scroll">${rounds.map((round) => {
    const rows = knockoutSlotRows(round.count);
    return `<section class="bracket-round"><h4>${esc(round.title)}</h4>${rows.map((slot) => {
      const matchId = round.start + slot.id - 1;
      const live = liveByMatch.get(`M${matchId}`) || null;
      const schedule = knockoutSchedule[matchId] || null;
      const dateText = live?.date ? formatSgtDate(live.date) : formatSgtDate(schedule?.date);
      const venueText = schedule?.venue ? `<div class="bracket-venue">${esc(schedule.venue)}</div>` : "";
      return `<article class="bracket-match">
        <div class="bracket-date">M${matchId} · ${esc(dateText)}</div>${venueText}
        <div class="bracket-team"><span class="team-shield"></span><strong>${esc(live?.home || slot.teamA)}</strong><span>${esc(live?.home_score ?? "")}</span></div>
        <div class="bracket-team"><span class="team-shield"></span><strong>${esc(live?.away || slot.teamB)}</strong><span>${esc(live?.away_score ?? "")}</span></div>
      </article>`;
    }).join("")}</section>`;
  }).join("")}</div></section>`;
}

function isKnockoutLiveMatch(match) {
  const descriptor = `${match.round || ""} ${match.stage || ""} ${match.match || ""}`;
  return /round of 32|round of 16|\br16\b|quarter|semi|final|third-place|knockout/i.test(descriptor)
    && !/group/i.test(descriptor);
}

function liveKnockoutRows(d) {
  const rows = [...(d.live_results || []), ...(state.live?.matches || [])];
  const seen = new Set();
  return rows
    .filter(isKnockoutLiveMatch)
    .filter((match) => {
      const key = `${match.date || ""}|${match.home || ""}|${match.away || ""}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
}

function knockoutOverview(d) {
  const liveRows = liveKnockoutRows(d);
  if (!liveRows.length) return "";
  return `<h4>Live knockout results</h4>${table(liveRows, [
    { key: "date", label: "Date", format: (v) => v ? new Date(v).toLocaleString() : "" },
    { key: "home", label: "Home" },
    { key: "home_score", label: "H" },
    { key: "away_score", label: "A" },
    { key: "away", label: "Away" },
    { key: "status", label: "Status" },
  ])}`;
}

function dataSources(d) {
  const rows = mergedSources(d);
  const warnings = rows.filter((s) => !["live", "reference", "optional_api", "not_configured"].includes(s.status)).length;
  return `<h2>Data Sources and Refresh Status</h2>${warnings ? `<p class="warn">Some public sites block static build fetches. Cached or starter data is labeled in Methodology and Caveats.</p>` : ""}<h3>2026 Groups</h3>${groupTables(d)}<h3>Knockout Stage</h3>${knockoutBracket(d)}${knockoutOverview(d)}`;
}

function sourceDetails(d) {
  const rows = mergedSources(d);
  return `<h3>Source Details</h3>${table(rows, [
    { key: "name", label: "Source" },
    { key: "status", label: "Status" },
    { key: "update_method", label: "Update Method" },
    { key: "rows", label: "Rows" },
    { key: "refresh_timer", label: "Next Refresh", html: true },
    { key: "note", label: "Note" },
    { key: "citation", label: "Citation" },
  ])}`;
}

function teamPower(d) {
  const rows = [...d.team_strength].sort((a, b) => b.strength_score - a.strength_score);
  const maxScore = Math.max(...rows.map((r) => Number(r.strength_score) || 0));
  const ratingBars = rows.slice(0, 20).map((r) => `<div class="qual-row"><strong>${esc(r.team)}</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (Number(r.strength_score) / maxScore) * 100)}%"></div></div><span>${num(r.strength_score, 1)}</span></div>`).join("");
  return `<h2>Team Power Ratings</h2><p class="muted">Strength is a 0-100 style rating, not a percentage. Squad value is shown in SGD for easier reading.</p><div class="card">${ratingBars}</div>${table(rows, [
    { key: "team", label: "Team" },
    { key: "group", label: "Group" },
    { key: "strength_score", label: "Strength", format: (v) => num(v, 1) },
    { key: "elo", label: "Elo", format: (v) => num(v, 0) },
    { key: "fifa_rank", label: "FIFA Rank", format: (v) => num(v, 0) },
    { key: "market_value_m", label: "Value SGD", format: sgdMillions },
  ])}`;
}

function groupStage(d) {
  const groups = [...new Set(d.groups.map((r) => r.group))].sort();
  const current = document.getElementById("group-select")?.value || groups[0];
  const teams = d.team_strength.filter((r) => r.group === current).sort((a, b) => a.team.localeCompare(b.team));
  const teamA = document.getElementById("team-a")?.value || teams[0].team;
  const teamB = document.getElementById("team-b")?.value || teams.find((t) => t.team !== teamA)?.team || teams[0].team;
  const matchup = d.matchups.find((m) => m.group === current && m.team_a === teamA && m.team_b === teamB);
  setTimeout(bindGroupControls, 0);
  return `<h2>Group Stage Simulator</h2><div class="controls-row"><label>Group<select id="group-select">${groups.map((g) => `<option ${g === current ? "selected" : ""}>${g}</option>`).join("")}</select></label><label>Country A<select id="team-a">${teams.map((t) => `<option ${t.team === teamA ? "selected" : ""}>${esc(t.team)}</option>`).join("")}</select></label><label>Country B<select id="team-b">${teams.map((t) => `<option ${t.team === teamB ? "selected" : ""}>${esc(t.team)}</option>`).join("")}</select></label></div>${matchup ? `<div class="kpi-grid"><div class="kpi"><span>${esc(teamA)} win</span><strong>${pct1(matchup.team_a_win)}</strong></div><div class="kpi"><span>Draw</span><strong>${pct1(matchup.draw)}</strong></div><div class="kpi"><span>${esc(teamB)} win</span><strong>${pct1(matchup.team_b_win)}</strong></div></div><p class="muted">Expected goals: ${esc(teamA)} ${num(matchup.team_a_expected_goals, 2)} - ${num(matchup.team_b_expected_goals, 2)} ${esc(teamB)}</p>` : `<p class="warn">Choose two different countries.</p>`}<h3>Scheduled Group Pairings</h3>${table(d.fixtures.filter((f) => f.group === current), [
    { key: "match_id", label: "Match" },
    { key: "home", label: "Country A" },
    { key: "away", label: "Country B" },
  ])}`;
}

function goalPaceLabel(total) {
  const value = Number(total || 0);
  if (value >= 3) return "Open game";
  if (value >= 2.35) return "Normal scoring";
  return "Tight game";
}

function goalTeamLabel(row, index) {
  const gd = Number(row.expected_goal_difference || 0);
  if (index === 0) return "Top projected attack";
  if (gd >= 0.35) return "Positive goal edge";
  if (gd >= 0) return "Small goal edge";
  return "Needs cleaner finishing";
}

function groupGoals(d) {
  const groups = [...new Set(d.groups.map((r) => r.group))].sort();
  const current = document.getElementById("goal-group-select")?.value || groups[0];
  const totals = d.goal_totals.filter((r) => r.group === current).sort((a, b) => b.expected_goals_for - a.expected_goals_for);
  const matches = d.goal_matches.filter((r) => r.group === current).sort((a, b) => a.match_id.localeCompare(b.match_id));
  const groupTotal = matches.reduce((sum, r) => sum + Number(r.total_expected_goals || 0), 0);
  const avgMatchGoals = groupTotal / Math.max(1, matches.length);
  const topTeam = totals[0];
  const maxFor = Math.max(0.1, ...totals.map((r) => Number(r.expected_goals_for || 0)));
  const maxAgainst = Math.max(0.1, ...totals.map((r) => Number(r.expected_goals_against || 0)));
  const highestMatch = [...matches].sort((a, b) => Number(b.total_expected_goals || 0) - Number(a.total_expected_goals || 0))[0];
  const teamCards = totals.map((row, index) => {
    const goalsFor = Number(row.expected_goals_for || 0);
    const goalsAgainst = Number(row.expected_goals_against || 0);
    const goalDiff = Number(row.expected_goal_difference || 0);
    return `<article class="goal-team-card">
      <div class="goal-rank">#${index + 1}</div>
      <div class="goal-team-main">
        <h3>${esc(row.team)}</h3>
        <span class="tag">${goalTeamLabel(row, index)}</span>
      </div>
      <div class="goal-main-number">${num(goalsFor, 1)}</div>
      <div class="goal-card-label">projected goals scored</div>
      <div class="goal-meter-row"><span>Attack</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, goalsFor / maxFor * 100)}%"></div></div><strong>${num(goalsFor, 2)}</strong></div>
      <div class="goal-meter-row danger"><span>Against</span><div class="bar-track"><div class="bar-fill" style="width:${Math.max(6, goalsAgainst / maxAgainst * 100)}%"></div></div><strong>${num(goalsAgainst, 2)}</strong></div>
      <div class="goal-diff ${goalDiff >= 0 ? "positive" : "negative"}">Goal difference ${goalDiff >= 0 ? "+" : ""}${num(goalDiff, 2)}</div>
    </article>`;
  }).join("");
  const matchCards = matches.map((row) => {
    const homeGoals = Number(row.home_expected_goals || 0);
    const awayGoals = Number(row.away_expected_goals || 0);
    const totalGoals = Number(row.total_expected_goals || 0);
    const edge = Math.abs(homeGoals - awayGoals);
    const lean = edge < 0.15 ? "Very even" : homeGoals > awayGoals ? `${row.home} edge` : `${row.away} edge`;
    return `<article class="goal-match-card">
      <div class="goal-match-top"><span>${esc(row.match_id)}</span><strong>${goalPaceLabel(totalGoals)}</strong></div>
      <div class="score-preview">
        <div><strong>${esc(row.home)}</strong><span>${num(homeGoals, 1)}</span></div>
        <b>vs</b>
        <div><strong>${esc(row.away)}</strong><span>${num(awayGoals, 1)}</span></div>
      </div>
      <div class="goal-match-foot"><span>${esc(lean)}</span><span>Total ${num(totalGoals, 2)}</span></div>
    </article>`;
  }).join("");
  setTimeout(() => document.getElementById("goal-group-select")?.addEventListener("change", render), 0);
  return `<h2>Goal Group Stage Simulator</h2><p class="muted">Expected goals are model estimates from team attack/defense strength, not guaranteed score predictions.</p><div class="controls-row"><label>Group<select id="goal-group-select">${groups.map((g) => `<option ${g === current ? "selected" : ""}>${g}</option>`).join("")}</select></label></div><section class="goal-hero">
    <div>
      <span class="section-eyebrow">Group ${esc(current)} goal preview</span>
      <h3>${esc(topTeam?.team || "-")} project as the strongest attack</h3>
      <p class="muted">This group projects for ${num(groupTotal, 1)} total goals across six matches, about ${num(avgMatchGoals, 2)} per match.</p>
    </div>
    <div class="goal-hero-stat"><strong>${num(avgMatchGoals, 2)}</strong><span>goals per match</span></div>
  </section><div class="kpi-grid"><div class="kpi"><span>Group expected goals</span><strong>${num(groupTotal, 1)}</strong></div><div class="kpi"><span>Highest-scoring fixture</span><strong>${highestMatch ? `${esc(highestMatch.home)} vs ${esc(highestMatch.away)}` : "-"}</strong></div><div class="kpi"><span>Top scoring team</span><strong>${esc(topTeam?.team || "-")}</strong></div></div><h3>Team Goal Preview</h3><div class="goal-team-grid">${teamCards}</div><h3>Match Score Preview</h3><div class="goal-match-grid">${matchCards}</div><details class="detail-drawer"><summary>Open detailed goal tables</summary>${table(totals, [
    { key: "team", label: "Team" },
    { key: "expected_goals_for", label: "Expected goals for", format: (v) => num(v, 2) },
    { key: "expected_goals_against", label: "Expected goals against", format: (v) => num(v, 2) },
    { key: "expected_goal_difference", label: "Expected goal difference", format: (v) => num(v, 2) },
  ])}${table(matches, [
    { key: "match_id", label: "Match" },
    { key: "home", label: "Country A" },
    { key: "home_expected_goals", label: "A goals", format: (v) => num(v, 2) },
    { key: "away", label: "Country B" },
    { key: "away_expected_goals", label: "B goals", format: (v) => num(v, 2) },
    { key: "total_expected_goals", label: "Total goals", format: (v) => num(v, 2) },
  ])}</details>`;
}

function bindGroupControls() {
  ["group-select", "team-a", "team-b"].forEach((id) => document.getElementById(id)?.addEventListener("change", render));
}

function groupVisual(d) {
  const sim = activeSimulation();
  const cards = [...new Set(d.groups.map((r) => r.group))].sort().map((g) => {
    const teams = sim.simulation_probabilities.filter((r) => r.group === g).sort((a, b) => b["Round of 32"] - a["Round of 32"]);
    return `<section class="group-card"><h3>Group ${esc(g)} -> Round of 32</h3>${teams.map((t) => `<div class="qual-row"><div><strong>${esc(t.team)}</strong><div class="tag">${t["Round of 32"] >= 0.75 ? "Likely through" : t["Round of 32"] >= 0.48 ? "Bubble" : "Needs help"}</div></div><div class="bar-track"><div class="bar-fill" style="width:${t["Round of 32"] * 100}%"></div></div><span>${pct(t["Round of 32"])}</span></div>`).join("")}<p class="muted">Top two plus best third-place routes.</p></section>`;
  }).join("");
  return `<h2>Who May Make It Out Of Each Group</h2><div class="grid">${cards}</div>`;
}

function countryPath(d) {
  const sort = state.countryPathSort || document.getElementById("country-sort")?.value || "az";
  const sim = activeSimulation();
  let teams = [...sim.simulation_probabilities];
  if (sort === "za") teams.sort((a, b) => b.team.localeCompare(a.team));
  else if (sort === "champion") teams.sort((a, b) => b.Champion - a.Champion || a.team.localeCompare(b.team));
  else teams.sort((a, b) => a.team.localeCompare(b.team));
  const current = state.countryPathTeam && teams.some((team) => team.team === state.countryPathTeam) ? state.countryPathTeam : teams[0].team;
  const row = sim.simulation_probabilities.find((r) => r.team === current);
  const stages = [["Group", 1], ["Round of 32", row["Round of 32"]], ["Quarter-finals", row["Quarter-finals"]], ["Semi-finals", row["Semi-finals"]], ["Final", row.Final], ["Champion", row.Champion]];
  const route = sim.bracket.filter((m) => m.team_a === current || m.team_b === current);
  setTimeout(() => {
    document.getElementById("country-sort")?.addEventListener("change", (event) => {
      state.countryPathSort = event.target.value;
      state.countryPathTeam = null;
      render();
    });
    document.getElementById("country-select")?.addEventListener("change", (event) => {
      state.countryPathTeam = event.target.value;
      render();
    });
  }, 0);
  return `<h2>Animated Possible Country Path</h2><div class="controls-row"><label>Country order<select id="country-sort"><option value="az" ${sort === "az" ? "selected" : ""}>A-Z order</option><option value="za" ${sort === "za" ? "selected" : ""}>Z-A order</option><option value="champion" ${sort === "champion" ? "selected" : ""}>Highest champion %</option></select></label><label>Country<select id="country-select">${teams.map((t) => `<option ${t.team === current ? "selected" : ""}>${esc(t.team)}</option>`).join("")}</select></label></div><div class="path-shell"><div class="path-track">${stages.map(([name, p]) => `<section class="path-stage"><strong>${esc(name)}</strong><div class="stage-percent">${pct(p)}</div><p class="muted">${p >= 0.7 ? "Strong chance." : p >= 0.4 ? "Realistic path." : p > 0 ? "Needs the path to break well." : "No path in sample."}</p><div class="bar-track"><div class="stage-meter-fill" style="--p:${p * 100}%; background:${p >= 0.4 ? "#2457a6" : "#b84a62"}"></div></div></section>`).join("")}</div></div><h3>One Sample Knockout Route</h3>${route.length ? table(route.map((m) => ({ round: m.round, match: m.match, opponent: m.team_a === current ? m.team_b : m.team_a, result: m.winner === current ? "Advanced" : "Eliminated" })), [{ key: "round", label: "Round" }, { key: "match", label: "Match" }, { key: "opponent", label: "Opponent" }, { key: "result", label: "Result" }]) : `<p class="warn">${esc(current)} did not reach the Round of 32 in this sampled bracket seed.</p>`}`;
}

function penalties(d) {
  return `<h2>Penalty Shootout Estimator</h2><p class="warn">Team-level proxy only: it does not ingest confirmed penalty takers, goalkeeper save rates, injuries, minutes played, or fatigue.</p>${table(d.penalties, [
    { key: "team", label: "Team" },
    { key: "group", label: "Group" },
    { key: "penalty_shootout_rating", label: "Shootout rating", format: (v) => num(v, 1) },
    { key: "win_vs_average_penalty_team", label: "Vs average", format: pct1 },
    { key: "player_condition_proxy", label: "Condition proxy", format: (v) => num(v, 1) },
    { key: "profile", label: "Profile" },
  ])}`;
}

function askAiContext(d) {
  const sim = activeSimulation();
  const standings = currentStandings(d);
  const stageRows = [...sim.simulation_probabilities]
    .sort((a, b) => b.Champion - a.Champion)
    .map((r) => ({
      t: r.team,
      g: r.group,
      r32: Number(r["Round of 32"] || 0).toFixed(3),
      qf: Number(r["Quarter-finals"] || 0).toFixed(3),
      sf: Number(r["Semi-finals"] || 0).toFixed(3),
      f: Number(r.Final || 0).toFixed(3),
      ch: Number(r.Champion || 0).toFixed(3),
    }));
  const standingRows = standings.map((r) => ({
    g: r.group,
    t: r.team,
    p: r.played,
    w: r.won,
    d: r.drawn,
    l: r.lost,
    pts: r.points,
  }));
  return {
    generated_at: d.generated_at,
    simulation: { count: sim.count, seed: sim.seed },
    sources: mergedSources(d).map((s) => ({ n: s.name, st: s.status, rows: s.rows, method: s.update_method })).slice(0, 10),
    standings: standingRows,
    live_matches: (state.live?.matches || []).slice(0, 8).map((m) => ({ date: m.date, h: m.home, hs: m.home_score, as: m.away_score, a: m.away, st: m.status })),
    stage_probabilities: stageRows,
    round32: sim.round32_analysis.slice(0, 10).map((r) => ({ m: r.match, fx: r.fixture, fav: r.favorite, p: Number(r.favorite_win_probability || 0).toFixed(3) })),
    bracket: sim.bracket.slice(0, 16).map((r) => ({ rd: r.round, m: r.match, a: r.team_a, b: r.team_b, w: r.winner })),
    team_power: [...d.team_strength].sort((a, b) => b.strength_score - a.strength_score).slice(0, 16).map((r) => ({ t: r.team, g: r.group, s: Number(r.strength_score || 0).toFixed(1) })),
    goal_matches: d.goal_matches.map((r) => ({ g: r.group, m: r.match_id, h: r.home, hg: Number(r.home_expected_goals || 0).toFixed(2), a: r.away, ag: Number(r.away_expected_goals || 0).toFixed(2), tg: Number(r.total_expected_goals || 0).toFixed(2) })),
    goal_totals: d.goal_totals.map((r) => ({ t: r.team, g: r.group, gf: Number(r.expected_goals_for || 0).toFixed(2), ga: Number(r.expected_goals_against || 0).toFixed(2), gd: Number(r.expected_goal_difference || 0).toFixed(2) })),
    penalties: [...d.penalties].sort((a, b) => b.penalty_shootout_rating - a.penalty_shootout_rating).slice(0, 10).map((r) => ({ t: r.team, rating: Number(r.penalty_shootout_rating || 0).toFixed(1) })),
  };
}

function bindAskAiControls() {
  document.getElementById("ask-ai-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    requestAskAi();
  });
}

function setAiResult(html) {
  const el = document.getElementById("ai-result");
  if (el) el.innerHTML = html;
}

function requestAskAi() {
  if (Date.now() < state.aiCooldownUntil) {
    updateAiCooldownTimer();
    setAiResult(`<p class="warn">Please wait ${formatDuration(state.aiCooldownUntil - Date.now())} before asking again.</p>`);
    return;
  }
  const input = document.getElementById("ask-ai-question");
  const question = String(input?.value || "").trim();
  if (!question) {
    setAiResult(`<p class="warn">Ask a question first.</p>`);
    return;
  }
  if (question.length > 1500) {
    setAiResult(`<p class="warn">Keep the question under 1500 characters.</p>`);
    return;
  }
  state.aiCooldownUntil = Date.now() + AI_COOLDOWN_MS;
  updateAiCooldownTimer();
  setAiResult(`<p class="muted">Asking AI using this dashboard's data...</p>`);
  fetch("/api/ask-ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, context: askAiContext(state.data) }),
  })
    .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
    .then(({ ok, body }) => {
      if (!ok) throw new Error(body.error || "Ask AI failed.");
      state.aiLastResult = body;
      setAiResult(`<div class="ai-answer"><div class="tag">Cached for ${Math.round((body.cache_seconds || 0) / 3600)} hours</div>${esc(body.answer).replace(/\n/g, "<br>")}</div>`);
    })
    .catch((err) => {
      setAiResult(`<p class="warn">${esc(err.message)}</p>`);
    });
}

function askAi(d) {
  setTimeout(() => {
    bindAskAiControls();
    updateAiCooldownTimer();
  }, 0);
  return `<h2>Ask AI</h2><p class="muted">Ask about this dashboard's data only: model odds, goals, groups, simulated bracket, live score feed, sources, team power, and penalty ratings.</p><form id="ask-ai-form" class="card ai-panel"><label class="ask-ai-label" for="ask-ai-question">Question</label><textarea id="ask-ai-question" maxlength="1500" rows="4" placeholder="Ask something about the World Cup model..."></textarea><div class="ai-submit-row"><button id="ask-ai-submit" class="primary-action" type="submit">Ask AI</button><span id="ai-cooldown-timer" class="ai-cooldown">Ready to ask</span></div><p class="muted mini">AI is limited to website data, max 1500 characters, one question every 10 seconds, and cached repeated answers.</p></form><div id="ai-result" class="card"><p class="muted">Ask a question to see an answer.</p></div>`;
}

function championOdds(d) {
  const sim = activeSimulation();
  const top = [...sim.simulation_probabilities].sort((a, b) => b.Champion - a.Champion);
  return `<h2>Champion Odds</h2><div class="card">${topBar(top, "team", "Champion", 20)}</div>${table(top.slice(0, 20), [
    { key: "team", label: "Team" },
    { key: "group", label: "Group" },
    { key: "Champion", label: "Champion", format: pct1 },
    { key: "Final", label: "Final", format: pct1 },
    { key: "Semi-finals", label: "Semi-final", format: pct1 },
  ])}`;
}

function simulationControls(d) {
  const options = d.simulation_options;
  if (!options) return "";
  setTimeout(() => {
    document.getElementById("sim-count")?.addEventListener("change", (event) => {
      state.simCount = Number(event.target.value);
      render();
    });
    document.getElementById("sim-seed")?.addEventListener("change", (event) => {
      state.simSeed = Number(event.target.value);
      render();
    });
  }, 0);
  return `<div class="sim-controls methodology-controls"><label>Simulations<select id="sim-count">${options.counts.map((c) => `<option value="${c}" ${String(c) === String(state.simCount) ? "selected" : ""}>${c}</option>`).join("")}</select></label><label>Seed<select id="sim-seed">${options.seeds.map((s) => `<option value="${s}" ${String(s) === String(state.simSeed) ? "selected" : ""}>${s}</option>`).join("")}</select></label><p class="muted mini">Applies to champion odds, animated country path, and group qualification pages.</p></div>`;
}

function methodology(d) {
  return `<h2>Methodology and Caveats</h2><h3>Simulation Settings</h3>${simulationControls(d)}<div class="card"><p>This static build precomputes the tournament model at deploy time. The browser then renders the dashboard without a Python server.</p><ul><li>ESPN live match data refreshes through a Cloudflare API route every ${cadenceMinutes()} minutes.</li><li>football-data.org is an optional fallback API when a Cloudflare token is configured.</li><li>Transfermarkt market values and the static prediction model refresh during the scheduled build every ${modelRefreshHours()} hours.</li><li>Random Forest models estimate stage probabilities.</li><li>Poisson goal models drive match result probabilities.</li><li>Simulation choices are precomputed static presets, not live Python runs.</li><li>Public sites may block build-time fetches; cached/seed data is labeled below.</li></ul></div>${sourceDetails(d)}`;
}

function render() {
  renderNav();
  const d = state.data;
  const content = document.getElementById("content");
  if (!d) {
    content.innerHTML = loadingSkeleton();
    return;
  }
  const sim = activeSimulation();
  updateRefreshTimer();
  const views = {
    "Data Sources and Refresh Status": dataSources,
    "Team Power Ratings": teamPower,
    "Group Stage Simulator": groupStage,
    "Goal Group Stage Simulator": groupGoals,
    "Group Qualification Visual": groupVisual,
    "Animated Country Path": countryPath,
    "Penalty Shootout Estimator": penalties,
    "Ask AI": askAi,
    "Champion Odds": championOdds,
    "Methodology and Caveats": methodology,
  };
  const view = views[state.page] || views[pages[0]];
  if (!views[state.page]) state.page = pages[0];
  content.classList.remove("content-enter");
  content.innerHTML = view(d);
  requestAnimationFrame(() => content.classList.add("content-enter"));
  updateCountdownBadges();
}

function loadLiveResults({ silent = false } = {}) {
  state.liveRefreshPending = true;
  state.lastLiveRefreshCheck = Date.now();
  return fetch(`/api/live-results?ts=${Date.now()}`, { cache: "no-store" })
    .then((r) => r.json())
    .then((live) => {
      const previousBuild = state.live?.generated_at;
      state.live = live;
      if (!silent || previousBuild !== live.generated_at || state.page === "Data Sources and Refresh Status") {
        render();
      }
      startRefreshTimer();
    })
    .catch((err) => {
      state.live = {
        generated_at: new Date().toISOString(),
        refresh_interval_seconds: cadenceMinutes() * 60,
        matches: [],
        sources: [{ name: "espn_scoreboard", status: "error", rows: 0, fetched_at: new Date().toISOString(), note: err.message }],
      };
      if (!silent) render();
    })
    .finally(() => {
      state.liveRefreshPending = false;
    });
}

function loadData({ silent = false } = {}) {
  return fetch(`data.json?ts=${Date.now()}`, { cache: "no-store" })
    .then((r) => r.json())
    .then((d) => {
      const previousBuild = state.data?.generated_at;
      state.data = d;
      state.simCount = d.simulations?.[`${state.simCount}-${state.simSeed}`] ? state.simCount : d.simulation_options?.default_count || d.simulation_count;
      state.simSeed = d.simulations?.[`${state.simCount}-${state.simSeed}`] ? state.simSeed : d.simulation_options?.default_seed || d.simulation_seed;
      if (!silent || previousBuild !== d.generated_at) {
        render();
      }
      loadLiveResults({ silent: true });
      startRefreshTimer();
    })
    .catch((err) => {
      if (!silent) {
        document.getElementById("content").innerHTML = `<p class="warn">Could not load static data: ${esc(err.message)}</p>`;
      }
    });
}

loadData();
render();
