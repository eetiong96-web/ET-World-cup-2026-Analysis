const pages = [
  "Data Sources and Refresh Status",
  "Team Power Ratings",
  "Group Stage Simulator",
  "Goal Group Stage Simulator",
  "Group Qualification Visual",
  "Animated Country Path",
  "Round of 32 Fixtures",
  "Penalty Shootout Estimator",
  "Bracket Path",
  "Stage Probability Table",
  "Champion Odds",
  "Model Validation",
  "Methodology and Caveats",
];

const state = { page: pages[0], data: null, simCount: null, simSeed: null };

const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
const pct1 = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;
const num = (v, d = 1) => Number(v || 0).toFixed(d);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

function table(rows, columns) {
  if (!rows || rows.length === 0) return `<p class="muted">No rows available.</p>`;
  return `<table><thead><tr>${columns.map((c) => `<th>${esc(c.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${columns.map((c) => `<td>${esc(c.format ? c.format(r[c.key], r) : r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

function topBar(rows, labelKey, valueKey, limit = 16) {
  return rows.slice(0, limit).map((r) => `<div class="qual-row"><strong>${esc(r[labelKey])}</strong><div class="bar-track"><div class="bar-fill" style="width:${Math.max(2, Number(r[valueKey]) * 100)}%"></div></div><span>${pct1(r[valueKey])}</span></div>`).join("");
}

function renderNav() {
  const d = state.data;
  const options = d?.simulation_options;
  const controls = options ? `<div class="sim-controls"><label>Simulations<select id="sim-count">${options.counts.map((c) => `<option value="${c}" ${String(c) === String(state.simCount) ? "selected" : ""}>${c}</option>`).join("")}</select></label><label>Seed<select id="sim-seed">${options.seeds.map((s) => `<option value="${s}" ${String(s) === String(state.simSeed) ? "selected" : ""}>${s}</option>`).join("")}</select></label></div>` : "";
  document.getElementById("nav").innerHTML = `${controls}${pages.map((p) => `<button class="nav-btn ${state.page === p ? "active" : ""}" data-page="${esc(p)}">${esc(p)}</button>`).join("")}`;
  document.querySelectorAll(".nav-btn").forEach((btn) => btn.addEventListener("click", () => {
    state.page = btn.dataset.page;
    render();
  }));
  document.getElementById("sim-count")?.addEventListener("change", (event) => {
    state.simCount = Number(event.target.value);
    render();
  });
  document.getElementById("sim-seed")?.addEventListener("change", (event) => {
    state.simSeed = Number(event.target.value);
    render();
  });
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

function dataSources(d) {
  const warnings = d.sources.filter((s) => s.status !== "live").length;
  return `<h2>Data Sources and Refresh Status</h2>${warnings ? `<p class="warn">Some public sites block static build fetches. Cached or starter data is labeled below.</p>` : ""}${table(d.sources, [
    { key: "name", label: "Source" },
    { key: "status", label: "Status" },
    { key: "rows", label: "Rows" },
    { key: "note", label: "Note" },
    { key: "citation", label: "Citation" },
  ])}<h3>2026 Groups</h3>${table(d.groups, [
    { key: "group", label: "Group" },
    { key: "position", label: "Pos" },
    { key: "team", label: "Team" },
  ])}`;
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

function methodology() {
  return `<h2>Methodology and Caveats</h2><div class="card"><p>This static build precomputes the tournament model at deploy time. The browser then renders the dashboard without a Python server.</p><ul><li>FIFA rankings, Elo, market values, and 2026 structure are fetched/cached during build.</li><li>Random Forest models estimate stage probabilities.</li><li>Poisson goal models drive match result probabilities.</li><li>Monte Carlo simulation count is fixed in this static build.</li><li>Public sites may block build-time fetches; cached/seed data is labeled in Sources.</li></ul></div>`;
}

function render() {
  renderNav();
  const d = state.data;
  const sim = activeSimulation();
  document.getElementById("build-meta").textContent = `Built ${d.generated_at} | ${sim.count} simulations | seed ${sim.seed}`;
  const views = {
    "Data Sources and Refresh Status": dataSources,
    "Team Power Ratings": teamPower,
    "Group Stage Simulator": groupStage,
    "Goal Group Stage Simulator": groupGoals,
    "Group Qualification Visual": groupVisual,
    "Animated Country Path": countryPath,
    "Round of 32 Fixtures": round32,
    "Penalty Shootout Estimator": penalties,
    "Bracket Path": bracket,
    "Stage Probability Table": stageTable,
    "Champion Odds": championOdds,
    "Model Validation": validation,
    "Methodology and Caveats": methodology,
  };
  document.getElementById("content").innerHTML = views[state.page](d);
}

fetch("data.json")
  .then((r) => r.json())
  .then((d) => {
    state.data = d;
    state.simCount = d.simulation_options?.default_count || d.simulation_count;
    state.simSeed = d.simulation_options?.default_seed || d.simulation_seed;
    render();
  })
  .catch((err) => {
    document.getElementById("content").innerHTML = `<p class="warn">Could not load static data: ${esc(err.message)}</p>`;
  });
