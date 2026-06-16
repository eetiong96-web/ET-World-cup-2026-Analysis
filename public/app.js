const pages = [
  "Data Sources and Refresh Status",
  "Team Power Ratings",
  "Group Stage Simulator",
  "Goal Group Stage Simulator",
  "Group Qualification Visual",
  "Animated Country Path",
  "Round of 32 Fixtures",
  "Penalty Shootout Estimator",
  "Ask AI",
  "Bracket Path",
  "Stage Probability Table",
  "Champion Odds",
  "Model Validation",
  "Methodology and Caveats",
];

const state = { page: pages[0], data: null, live: null, simCount: null, simSeed: null, refreshTimer: null, liveRefreshPending: false, lastLiveRefreshCheck: 0, aiCooldownUntil: 0, aiLastResult: null };

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

function cadenceMinutes() {
  return Number(state.data?.refresh_cadences?.live_results_minutes || 5);
}

function modelRefreshHours() {
  return Number(state.data?.refresh_cadences?.model_refresh_hours || 8);
}

function sourceRefreshMs(source) {
  if (["espn_scoreboard", "football_data_org"].includes(source.name)) return cadenceMinutes() * 60 * 1000;
  if (source.name === "transfermarkt_values") return Number(state.data?.refresh_cadences?.transfermarkt_values_hours || 8) * 60 * 60 * 1000;
  return 0;
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
    el.textContent = `Live match API refresh in ${formatDuration(remaining)} | model refresh every ${modelRefreshHours()}h`;
    el.classList.remove("checking");
    updateCountdownBadges();
    return;
  }
  el.textContent = "Checking live match API...";
  el.classList.add("checking");
  updateCountdownBadges();
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

function topBar(rows, labelKey, valueKey, limit = 16) {
  return rows.slice(0, limit).map((r) => `<div class="qual-row"><strong>${esc(r[labelKey])}</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Number(r[valueKey]) * 100)}%"></div></div><span>${pct1(r[valueKey])}</span></div>`).join("");
}

function renderNav() {
  document.getElementById("nav").innerHTML = pages.map((p) => `<button class="nav-btn ${state.page === p ? "active" : ""}" data-page="${esc(p)}">${esc(p)}</button>`).join("");
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => {
    state.page = btn.dataset.page;
    render();
  }));
}

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
    update_method: source.name === "transfermarkt_values"
      ? "Build refresh, 8h"
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

function liveScorePanel() {
  if (!state.live) return `<p class="muted">Live API loading...</p>`;
  const rows = state.live.matches || [];
  return `<h3>Live Match API</h3><div class="kpi-grid"><div class="kpi"><span>API status</span><strong>${esc(state.live.sources?.[0]?.status || "checking")}</strong></div><div class="kpi"><span>Rows</span><strong>${rows.length}</strong></div><div class="kpi"><span>API refreshed</span><strong>${esc(new Date(state.live.generated_at).toLocaleTimeString())}</strong></div></div>${table(rows.slice(0, 12), [
    { key: "date", label: "Date", format: (v) => v ? new Date(v).toLocaleString() : "" },
    { key: "home", label: "Home" },
    { key: "home_score", label: "H" },
    { key: "away_score", label: "A" },
    { key: "away", label: "Away" },
    { key: "status", label: "Status" },
    { key: "provider", label: "API" },
  ])}`;
}

function groupTables(d) {
  const groups = [...new Set(d.groups.map((r) => r.group))].sort();
  return `<div class="group-table-grid">${groups.map((group) => {
    const rows = d.groups.filter((r) => r.group === group).sort((a, b) => a.position - b.position);
    return `<section class="group-table-card"><h4>Group ${esc(group)}</h4><table class="compact-table"><thead><tr><th>Pos</th><th>Team</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.position)}</td><td>${esc(row.team)}</td></tr>`).join("")}</tbody></table></section>`;
  }).join("")}</div>`;
}

function knockoutOverview(d) {
  const sim = activeSimulation();
  const roundLabels = [
    ["Round of 32", "Round of 32"],
    ["R16", "Round of 16"],
    ["QF", "Quarter-finals"],
    ["SF", "Semi-finals"],
    ["Final", "Final"],
  ];
  const liveRows = (state.live?.matches || []).filter((match) => /round|quarter|semi|final|knockout/i.test(`${match.match || ""} ${match.status || ""}`));
  return `<p class="muted">Knockout rows below use the selected simulated bracket for now. Live knockout results can appear here once the public API exposes those matches during the tournament.</p>${liveRows.length ? `<h4>Live Knockout Matches</h4>${table(liveRows, [
    { key: "date", label: "Date", format: (v) => v ? new Date(v).toLocaleString() : "" },
    { key: "home", label: "Home" },
    { key: "home_score", label: "H" },
    { key: "away_score", label: "A" },
    { key: "away", label: "Away" },
    { key: "status", label: "Status" },
  ])}` : ""}<div class="knockout-grid">${roundLabels.map(([round, label]) => {
    const rows = sim.bracket.filter((row) => row.round === round);
    return `<section class="knockout-card"><h4>${esc(label)}</h4>${rows.length ? `<table class="compact-table knockout-table"><thead><tr><th>Match</th><th>Fixture</th><th>Winner</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${esc(row.match)}</td><td>${esc(row.team_a)} vs ${esc(row.team_b)}</td><td>${esc(row.winner)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted mini">Pending.</p>`}</section>`;
  }).join("")}</div>`;
}

function dataSources(d) {
  const rows = mergedSources(d);
  const warnings = rows.filter((s) => !["live", "reference", "optional_api", "not_configured"].includes(s.status)).length;
  return `<h2>Data Sources and Refresh Status</h2>${warnings ? `<p class="warn">Some public sites block static build fetches. Cached or starter data is labeled below.</p>` : ""}${liveScorePanel()}<h3>Source Details</h3>${table(rows, [
    { key: "name", label: "Source" },
    { key: "status", label: "Status" },
    { key: "update_method", label: "Update Method" },
    { key: "rows", label: "Rows" },
    { key: "refresh_timer", label: "Next Refresh", html: true },
    { key: "note", label: "Note" },
    { key: "citation", label: "Citation" },
  ])}<h3>2026 Groups</h3>${groupTables(d)}<h3>Knockout Stage</h3>${knockoutOverview(d)}`;
}

function teamPower(d) {
  const rows = [...d.team_strength].sort((a, b) => b.strength_score - a.strength_score);
  const maxScore = Math.max(...rows.map((r) => Number(r.strength_score) || 0));
  const ratingBars = rows.slice(0, 20).map((r) => `<div class="qual-row"><strong>${esc(r.team)}</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, (Number(r.strength_score) / maxScore) * 100)}%"></div></div><span>${num(r.strength_score, 1)}</span></div>`).join("");
  return `<h2>Team Power Ratings</h2><p class="muted">Strength is a 0-100 style rating, not a percentage.</p><div class="card">${ratingBars}</div>${table(rows, [
    { key: "team", label: "Team" },
    { key: "group", label: "Group" },
    { key: "strength_score", label: "Strength", format: (v) => num(v, 1) },
    { key: "elo", label: "Elo", format: (v) => num(v, 0) },
    { key: "fifa_rank", label: "FIFA Rank", format: (v) => num(v, 0) },
    { key: "market_value_m", label: "Value EUR m", format: (v) => num(v, 0) },
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

function groupGoals(d) {
  const groups = [...new Set(d.groups.map((r) => r.group))].sort();
  const current = document.getElementById("goal-group-select")?.value || groups[0];
  const totals = d.goal_totals.filter((r) => r.group === current).sort((a, b) => b.expected_goals_for - a.expected_goals_for);
  const matches = d.goal_matches.filter((r) => r.group === current).sort((a, b) => a.match_id.localeCompare(b.match_id));
  const groupTotal = matches.reduce((sum, r) => sum + Number(r.total_expected_goals || 0), 0);
  setTimeout(() => document.getElementById("goal-group-select")?.addEventListener("change", render), 0);
  return `<h2>Goal Group Stage Simulator</h2><p class="muted">Expected goals are model estimates from team attack/defense strength, not guaranteed score predictions.</p><div class="controls-row"><label>Group<select id="goal-group-select">${groups.map((g) => `<option ${g === current ? "selected" : ""}>${g}</option>`).join("")}</select></label></div><div class="kpi-grid"><div class="kpi"><span>Group expected goals</span><strong>${num(groupTotal, 1)}</strong></div><div class="kpi"><span>Average per match</span><strong>${num(groupTotal / Math.max(1, matches.length), 2)}</strong></div><div class="kpi"><span>Top scoring team</span><strong>${esc(totals[0]?.team || "-")}</strong></div></div><h3>Team Goal Projection</h3><div class="card">${totals.map((r) => `<div class="qual-row"><strong>${esc(r.team)}</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Number(r.expected_goals_for) / Math.max(...totals.map((x) => Number(x.expected_goals_for))) * 100)}%"></div></div><span>${num(r.expected_goals_for, 2)}</span></div>`).join("")}</div>${table(totals, [
    { key: "team", label: "Team" },
    { key: "expected_goals_for", label: "Expected goals for", format: (v) => num(v, 2) },
    { key: "expected_goals_against", label: "Expected goals against", format: (v) => num(v, 2) },
    { key: "expected_goal_difference", label: "Expected goal difference", format: (v) => num(v, 2) },
  ])}<h3>Match Goal Projection</h3>${table(matches, [
    { key: "match_id", label: "Match" },
    { key: "home", label: "Country A" },
    { key: "home_expected_goals", label: "A goals", format: (v) => num(v, 2) },
    { key: "away", label: "Country B" },
    { key: "away_expected_goals", label: "B goals", format: (v) => num(v, 2) },
    { key: "total_expected_goals", label: "Total goals", format: (v) => num(v, 2) },
  ])}`;
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
  const sort = document.getElementById("country-sort")?.value || "az";
  const sim = activeSimulation();
  let teams = [...sim.simulation_probabilities];
  if (sort === "za") teams.sort((a, b) => b.team.localeCompare(a.team));
  else if (sort === "champion") teams.sort((a, b) => b.Champion - a.Champion || a.team.localeCompare(b.team));
  else teams.sort((a, b) => a.team.localeCompare(b.team));
  const current = document.getElementById("country-select")?.value || teams[0].team;
  const row = sim.simulation_probabilities.find((r) => r.team === current);
  const stages = [["Group", 1], ["Round of 32", row["Round of 32"]], ["Quarter-finals", row["Quarter-finals"]], ["Semi-finals", row["Semi-finals"]], ["Final", row.Final], ["Champion", row.Champion]];
  const route = sim.bracket.filter((m) => m.team_a === current || m.team_b === current);
  setTimeout(() => {
    document.getElementById("country-sort")?.addEventListener("change", render);
    document.getElementById("country-select")?.addEventListener("change", render);
  }, 0);
  return `<h2>Animated Possible Country Path</h2><div class="controls-row"><label>Country order<select id="country-sort"><option value="az" ${sort === "az" ? "selected" : ""}>A-Z order</option><option value="za" ${sort === "za" ? "selected" : ""}>Z-A order</option><option value="champion" ${sort === "champion" ? "selected" : ""}>Highest champion %</option></select></label><label>Country<select id="country-select">${teams.map((t) => `<option ${t.team === current ? "selected" : ""}>${esc(t.team)}</option>`).join("")}</select></label></div><div class="path-shell"><div class="path-track">${stages.map(([name, p]) => `<section class="path-stage"><strong>${esc(name)}</strong><div class="stage-percent">${pct(p)}</div><p class="muted">${p >= 0.7 ? "Strong chance." : p >= 0.4 ? "Realistic path." : p > 0 ? "Needs the path to break well." : "No path in sample."}</p><div class="bar-track"><div class="stage-meter-fill" style="--p:${p * 100}%; background:${p >= 0.4 ? "#2457a6" : "#b84a62"}"></div></div></section>`).join("")}</div></div><h3>One Sample Knockout Route</h3>${route.length ? table(route.map((m) => ({ round: m.round, match: m.match, opponent: m.team_a === current ? m.team_b : m.team_a, result: m.winner === current ? "Advanced" : "Eliminated" })), [{ key: "round", label: "Round" }, { key: "match", label: "Match" }, { key: "opponent", label: "Opponent" }, { key: "result", label: "Result" }]) : `<p class="warn">${esc(current)} did not reach the Round of 32 in this sampled bracket seed.</p>`}`;
}

function round32(d) {
  const sim = activeSimulation();
  return `<h2>Round of 32 Fixture Analysis</h2>${table(sim.round32_analysis, [
    { key: "match", label: "Match" },
    { key: "fixture", label: "Fixture" },
    { key: "favorite", label: "Favorite" },
    { key: "favorite_win_probability", label: "Favorite win", format: pct1 },
    { key: "team_a_expected_goals", label: "A xG", format: (v) => num(v, 2) },
    { key: "team_b_expected_goals", label: "B xG", format: (v) => num(v, 2) },
    { key: "analysis", label: "Analysis" },
  ])}`;
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
  return {
    generated_at: d.generated_at,
    simulation: { count: sim.count, seed: sim.seed },
    sources: mergedSources(d),
    groups: d.groups,
    live_matches: state.live?.matches || [],
    top_champion_odds: [...sim.simulation_probabilities].sort((a, b) => b.Champion - a.Champion).slice(0, 15),
    group_qualification: [...sim.simulation_probabilities].sort((a, b) => a.group.localeCompare(b.group) || b["Round of 32"] - a["Round of 32"]),
    round32: sim.round32_analysis,
    bracket: sim.bracket,
    team_power: [...d.team_strength].sort((a, b) => b.strength_score - a.strength_score).slice(0, 24),
    penalties: [...d.penalties].sort((a, b) => b.penalty_shootout_rating - a.penalty_shootout_rating).slice(0, 16),
  };
}

function bindAskAiControls() {
  document.getElementById("ask-ai-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    requestAskAi();
  });
  document.querySelectorAll("[data-ai-example]").forEach((button) => button.addEventListener("click", () => {
    const input = document.getElementById("ask-ai-question");
    if (input) input.value = button.dataset.aiExample;
  }));
}

function setAiResult(html) {
  const el = document.getElementById("ai-result");
  if (el) el.innerHTML = html;
}

function requestAskAi() {
  if (Date.now() < state.aiCooldownUntil) {
    setAiResult(`<p class="warn">Please wait ${formatDuration(state.aiCooldownUntil - Date.now())} before asking again.</p>`);
    return;
  }
  const input = document.getElementById("ask-ai-question");
  const question = String(input?.value || "").trim();
  if (!question) {
    setAiResult(`<p class="warn">Ask a question first.</p>`);
    return;
  }
  if (question.length > 280) {
    setAiResult(`<p class="warn">Keep the question under 280 characters.</p>`);
    return;
  }
  state.aiCooldownUntil = Date.now() + 30000;
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
  setTimeout(bindAskAiControls, 0);
  const examples = [
    "Which team is most likely to win and why?",
    "Which group looks hardest?",
    "Can Mexico reach the quarter-finals?",
    "Who are good upset picks?",
  ];
  return `<h2>Ask AI</h2><p class="muted">Ask about this dashboard's data only: model odds, groups, simulated bracket, live score feed, sources, team power, and penalty ratings.</p><form id="ask-ai-form" class="card ai-panel"><label class="ask-ai-label" for="ask-ai-question">Question</label><textarea id="ask-ai-question" maxlength="280" rows="4" placeholder="Ask something about the World Cup model..."></textarea><div class="ai-actions">${examples.map((q) => `<button type="button" data-ai-example="${esc(q)}">${esc(q)}</button>`).join("")}</div><button class="primary-action" type="submit">Ask AI</button><p class="muted mini">AI is limited to website data, max 280 characters, one question every 30 seconds, and cached repeated answers.</p></form><div id="ai-result" class="card"><p class="muted">Ask a question to see an answer.</p></div>`;
}

function bracket(d) {
  const sim = activeSimulation();
  return `<h2>Sample Simulated Bracket Path</h2>${table(sim.bracket, [
    { key: "round", label: "Round" },
    { key: "match", label: "Match" },
    { key: "team_a", label: "Team A" },
    { key: "team_b", label: "Team B" },
    { key: "winner", label: "Winner" },
  ])}`;
}

function stageTable(d) {
  const sim = activeSimulation();
  const joined = sim.simulation_probabilities.map((s) => ({ ...s, ...(d.model_probabilities.find((m) => m.team === s.team) || {}) })).sort((a, b) => b.Champion - a.Champion);
  return `<h2>Stage Probability Table</h2>${table(joined, [
    { key: "team", label: "Team" },
    { key: "group", label: "Group" },
    { key: "Round of 32", label: "R32", format: pct1 },
    { key: "Quarter-finals", label: "QF sim", format: pct1 },
    { key: "Semi-finals", label: "SF sim", format: pct1 },
    { key: "Final", label: "Final sim", format: pct1 },
    { key: "Champion", label: "Champion sim", format: pct1 },
  ])}`;
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

function validation(d) {
  return `<h2>Model Validation</h2>${table(d.validation, [
    { key: "target", label: "Target" },
    { key: "held_out_year", label: "Held-out year" },
    { key: "log_loss", label: "Log loss", format: (v) => num(v, 3) },
    { key: "brier", label: "Brier", format: (v) => num(v, 3) },
  ])}<h3>Feature Importance</h3>${table(d.feature_importance, [
    { key: "feature", label: "Feature" },
    { key: "importance", label: "Importance", format: (v) => num(v, 3) },
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
  return `<div class="sim-controls methodology-controls"><label>Simulations<select id="sim-count">${options.counts.map((c) => `<option value="${c}" ${String(c) === String(state.simCount) ? "selected" : ""}>${c}</option>`).join("")}</select></label><label>Seed<select id="sim-seed">${options.seeds.map((s) => `<option value="${s}" ${String(s) === String(state.simSeed) ? "selected" : ""}>${s}</option>`).join("")}</select></label><p class="muted mini">Applies to odds, bracket, animated country path, Round of 32, and group qualification pages.</p></div>`;
}

function methodology(d) {
  return `<h2>Methodology and Caveats</h2><h3>Simulation Settings</h3>${simulationControls(d)}<div class="card"><p>This static build precomputes the tournament model at deploy time. The browser then renders the dashboard without a Python server.</p><ul><li>ESPN live match data refreshes through a Cloudflare API route every ${cadenceMinutes()} minutes.</li><li>football-data.org is an optional fallback API when a Cloudflare token is configured.</li><li>Transfermarkt market values and the static prediction model refresh during the scheduled build every ${modelRefreshHours()} hours.</li><li>Random Forest models estimate stage probabilities.</li><li>Poisson goal models drive match result probabilities.</li><li>Simulation choices are precomputed static presets, not live Python runs.</li><li>Public sites may block build-time fetches; cached/seed data is labeled in Sources.</li></ul></div>`;
}

function render() {
  renderNav();
  const d = state.data;
  const sim = activeSimulation();
  document.getElementById("build-meta").textContent = `Built ${d.generated_at} | ${sim.count} simulations | seed ${sim.seed}`;
  updateRefreshTimer();
  const views = {
    "Data Sources and Refresh Status": dataSources,
    "Team Power Ratings": teamPower,
    "Group Stage Simulator": groupStage,
    "Goal Group Stage Simulator": groupGoals,
    "Group Qualification Visual": groupVisual,
    "Animated Country Path": countryPath,
    "Round of 32 Fixtures": round32,
    "Penalty Shootout Estimator": penalties,
    "Ask AI": askAi,
    "Bracket Path": bracket,
    "Stage Probability Table": stageTable,
    "Champion Odds": championOdds,
    "Model Validation": validation,
    "Methodology and Caveats": methodology,
  };
  document.getElementById("content").innerHTML = views[state.page](d);
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
