from __future__ import annotations

from html import escape

import numpy as np
import pandas as pd
import streamlit as st

from wc2026.data_fetch import load_all_data, source_table
from wc2026.features import build_team_strength, make_training_frame
from wc2026.models import predict_stage_probabilities, train_stage_models, validate_groupkfold
from wc2026.simulation import analyze_round_of_32, expected_goals, run_monte_carlo, score_matrix

st.set_page_config(page_title="World Cup 2026 Analysis Generator", layout="wide")

st.markdown(
    """
<style>
.group-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}
.group-card {
  border: 1px solid #d9e0ea;
  border-radius: 8px;
  padding: 14px;
  background: #ffffff;
}
.group-title {
  font-size: 1.05rem;
  font-weight: 700;
  color: #172033;
  margin-bottom: 10px;
}
.qual-row {
  display: grid;
  grid-template-columns: minmax(96px, 1fr) minmax(115px, 1.3fr) 64px;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  margin: 8px 0;
}
.team-name {
  font-weight: 650;
  color: #172033;
  overflow-wrap: anywhere;
}
.bar-track {
  height: 10px;
  background: #e9eef5;
  border-radius: 999px;
  overflow: hidden;
}
.bar-fill {
  height: 10px;
  border-radius: 999px;
}
.prob-label {
  font-variant-numeric: tabular-nums;
  text-align: right;
  color: #172033;
  font-weight: 650;
}
.tag {
  display: inline-block;
  margin-top: 2px;
  font-size: 0.72rem;
  color: #516072;
}
.route-line {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #edf1f6;
  color: #516072;
  font-size: 0.82rem;
}
.path-shell {
  border: 1px solid #d9e0ea;
  border-radius: 8px;
  background: #ffffff;
  padding: 16px;
  overflow-x: auto;
}
.path-track {
  display: grid;
  grid-template-columns: repeat(6, minmax(135px, 1fr));
  gap: 12px;
  align-items: stretch;
}
.path-stage {
  position: relative;
  min-height: 148px;
  border: 1px solid #e3e9f2;
  border-radius: 8px;
  padding: 12px;
  background: #f8fafc;
}
.path-stage::after {
  content: "";
  position: absolute;
  top: 50%;
  right: -13px;
  width: 13px;
  height: 2px;
  background: #b9c5d6;
}
.path-stage:last-child::after {
  display: none;
}
.stage-name {
  font-weight: 750;
  color: #172033;
  min-height: 42px;
}
.stage-percent {
  font-size: 1.45rem;
  font-weight: 800;
  color: #172033;
  margin: 8px 0 6px;
}
.stage-note {
  color: #516072;
  font-size: 0.78rem;
  min-height: 34px;
}
.stage-meter {
  height: 9px;
  background: #e4eaf3;
  border-radius: 999px;
  overflow: hidden;
  margin-top: 10px;
}
.stage-meter-fill {
  height: 9px;
  border-radius: 999px;
  width: var(--p);
  animation: grow-stage 1.05s ease-out both;
}
.stage-pulse {
  box-shadow: 0 0 0 0 rgba(36, 87, 166, 0.36);
  animation: stage-pulse 1.6s ease-out infinite;
}
@keyframes grow-stage {
  from { width: 0%; }
  to { width: var(--p); }
}
@keyframes stage-pulse {
  0% { box-shadow: 0 0 0 0 rgba(36, 87, 166, 0.32); }
  70% { box-shadow: 0 0 0 8px rgba(36, 87, 166, 0); }
  100% { box-shadow: 0 0 0 0 rgba(36, 87, 166, 0); }
}
@media (max-width: 900px) {
  .path-track {
    grid-template-columns: 1fr;
  }
  .path-stage::after {
    top: auto;
    right: 50%;
    bottom: -13px;
    width: 2px;
    height: 13px;
  }
}
</style>
    """,
    unsafe_allow_html=True,
)


@st.cache_data(show_spinner=False)
def cached_data():
    return load_all_data()


@st.cache_resource(show_spinner=False)
def cached_models():
    return train_stage_models(make_training_frame())


@st.cache_data(show_spinner=False)
def cached_validation():
    return validate_groupkfold(make_training_frame())


@st.cache_data(show_spinner=False)
def cached_simulation(team_strength: pd.DataFrame, fixtures: pd.DataFrame, n: int, seed: int):
    return run_monte_carlo(team_strength, fixtures, n=n, seed=seed)


def qualification_status(probability: float) -> tuple[str, str]:
    if probability >= 0.75:
        return "Likely through", "#2457A6"
    if probability >= 0.48:
        return "Bubble", "#D88919"
    return "Needs help", "#B84A62"


def render_group_qualification(groups: pd.DataFrame, sim_probs: pd.DataFrame) -> str:
    merged = groups.merge(sim_probs[["team", "Round of 32"]], on="team", how="left")
    merged["Round of 32"] = merged["Round of 32"].fillna(0)
    cards = []
    for group, frame in merged.groupby("group"):
        rows = []
        for _, row in frame.sort_values("Round of 32", ascending=False).iterrows():
            probability = float(row["Round of 32"])
            status, color = qualification_status(probability)
            team = escape(str(row["team"]))
            rows.append(
                f'<div class="qual-row">'
                f'<div><div class="team-name">{team}</div><span class="tag">{status}</span></div>'
                f'<div class="bar-track"><div class="bar-fill" style="width:{probability * 100:.1f}%; background:{color};"></div></div>'
                f'<div class="prob-label">{probability * 100:.0f}%</div>'
                f'</div>'
            )
        cards.append(
            f'<section class="group-card">'
            f'<div class="group-title">Group {escape(str(group))} &rarr; Round of 32</div>'
            f'{"".join(rows)}'
            f'<div class="route-line">Top two advance directly; the eight strongest third-place teams also survive.</div>'
            f'</section>'
        )
    return f'<div class="group-grid">{"".join(cards)}</div>'


def stage_note(probability: float, stage: str) -> tuple[str, str]:
    if probability >= 0.70:
        return f"Strong chance to reach {stage.lower()}.", "#2457A6"
    if probability >= 0.40:
        return f"Realistic path to {stage.lower()}.", "#D88919"
    if probability >= 0.15:
        return "Outside shot; needs the draw to break well.", "#6B6F7A"
    if probability > 0:
        return "Long shot from the current model.", "#B84A62"
    return "No path seen in this simulation sample.", "#9AA5B1"


def render_country_path(country: str, sim_probs: pd.DataFrame) -> str:
    row = sim_probs[sim_probs["team"] == country].iloc[0]
    stages = [
        ("Group", 1.0),
        ("Round of 32", float(row["Round of 32"])),
        ("Quarter-finals", float(row["Quarter-finals"])),
        ("Semi-finals", float(row["Semi-finals"])),
        ("Final", float(row["Final"])),
        ("Champion", float(row["Champion"])),
    ]
    cards = []
    for index, (stage, probability) in enumerate(stages):
        note = "Starts here." if stage == "Group" else stage_note(probability, stage)[0]
        color = "#2457A6" if stage == "Group" else stage_note(probability, stage)[1]
        pulse_class = " stage-pulse" if index == 0 or probability >= 0.40 else ""
        cards.append(
            f'<section class="path-stage{pulse_class}">'
            f'<div class="stage-name">{escape(stage)}</div>'
            f'<div class="stage-percent">{probability * 100:.0f}%</div>'
            f'<div class="stage-note">{escape(note)}</div>'
            f'<div class="stage-meter"><div class="stage-meter-fill" style="--p:{probability * 100:.1f}%; background:{color};"></div></div>'
            f'</section>'
        )
    return f'<div class="path-shell"><div class="path-track">{"".join(cards)}</div></div>'


def sampled_country_matches(country: str, bracket: pd.DataFrame) -> pd.DataFrame:
    if bracket.empty:
        return pd.DataFrame(columns=["round", "match", "opponent", "result"])
    rows = []
    for match in bracket.itertuples():
        if country not in {match.team_a, match.team_b}:
            continue
        opponent = match.team_b if match.team_a == country else match.team_a
        result = "Advanced" if match.winner == country else "Eliminated"
        rows.append({"round": match.round, "match": match.match, "opponent": opponent, "result": result})
        if result == "Eliminated":
            break
    return pd.DataFrame(rows)


def scale_0_100(series: pd.Series, higher_is_better: bool = True) -> pd.Series:
    values = series.astype(float)
    span = values.max() - values.min()
    if span == 0:
        scaled = pd.Series(50.0, index=series.index)
    else:
        scaled = (values - values.min()) / span * 100
    return scaled if higher_is_better else 100 - scaled


def build_penalty_table(team_strength: pd.DataFrame) -> pd.DataFrame:
    table = team_strength[["team", "group", "elo", "fifa_rank", "market_value_m", "defense", "knockout_index", "host"]].copy()
    table["squad_quality"] = scale_0_100(table["market_value_m"])
    table["team_composure"] = scale_0_100(table["elo"])
    table["ranking_strength"] = scale_0_100(table["fifa_rank"], higher_is_better=False)
    table["keeper_defense_proxy"] = scale_0_100(1 / table["defense"])
    table["knockout_experience_proxy"] = scale_0_100(table["knockout_index"])
    table["player_condition_proxy"] = (
        table["squad_quality"] * 0.42
        + table["team_composure"] * 0.24
        + table["ranking_strength"] * 0.18
        + table["keeper_defense_proxy"] * 0.10
        + table["knockout_experience_proxy"] * 0.06
    ).clip(0, 100)
    table["penalty_shootout_rating"] = (
        table["player_condition_proxy"] * 0.62
        + table["keeper_defense_proxy"] * 0.18
        + table["team_composure"] * 0.12
        + table["knockout_experience_proxy"] * 0.08
        + table["host"] * 2.0
    ).clip(0, 100)
    table["win_vs_average_penalty_team"] = 1 / (1 + pow(2.718281828, -(table["penalty_shootout_rating"] - 50) / 12))
    table["profile"] = table["penalty_shootout_rating"].map(penalty_profile)
    return table.sort_values("penalty_shootout_rating", ascending=False)


def penalty_profile(score: float) -> str:
    if score >= 72:
        return "Elite shootout profile"
    if score >= 58:
        return "Strong shootout profile"
    if score >= 44:
        return "Competitive shootout profile"
    return "Risky shootout profile"


def penalty_head_to_head(table: pd.DataFrame, team_a: str, team_b: str) -> tuple[float, float]:
    rating_a = float(table.loc[table["team"] == team_a, "penalty_shootout_rating"].iloc[0])
    rating_b = float(table.loc[table["team"] == team_b, "penalty_shootout_rating"].iloc[0])
    p_a = 1 / (1 + pow(2.718281828, -(rating_a - rating_b) / 11))
    return p_a, 1 - p_a


def match_result_probabilities(team_strength: pd.DataFrame, team_a: str, team_b: str) -> dict[str, float]:
    by_team = team_strength.set_index("team")
    a_row = by_team.loc[team_a]
    b_row = by_team.loc[team_b]
    a_xg, b_xg = expected_goals(a_row, b_row)
    matrix = score_matrix(a_xg, b_xg, max_goals=8)
    team_a_win = float(matrix[np.tril_indices_from(matrix, -1)].sum())
    draw = float(matrix.diagonal().sum())
    team_b_win = float(matrix[np.triu_indices_from(matrix, 1)].sum())
    return {
        "team_a_expected_goals": a_xg,
        "team_b_expected_goals": b_xg,
        "team_a_win": team_a_win,
        "draw": draw,
        "team_b_win": team_b_win,
    }


st.title("World Cup 2026 Analysis Generator")

with st.sidebar:
    st.header("Controls")
    simulations = st.slider("Monte Carlo simulations", 250, 10000, 2000, step=250)
    seed = st.number_input("Random seed", min_value=1, value=26, step=1)
    page = st.radio(
        "View",
        [
            "Data Sources and Refresh Status",
            "Team Power Ratings",
            "Group Stage Simulator",
            "Group Qualification Visual",
            "Animated Country Path",
            "Round of 32 Fixtures",
            "Penalty Shootout Estimator",
            "Bracket Path",
            "Stage Probability Table",
            "Champion Odds",
            "Model Validation",
            "Methodology and Caveats",
        ],
    )

SIMULATION_PAGES = {
    "Group Qualification Visual",
    "Animated Country Path",
    "Round of 32 Fixtures",
    "Bracket Path",
    "Stage Probability Table",
    "Champion Odds",
}

with st.spinner("Loading tournament data..."):
    data = cached_data()
    team_strength = build_team_strength(data["groups"], data["rankings"], data["elo"], data["values"])

if page in SIMULATION_PAGES:
    with st.spinner("Running tournament simulation..."):
        sim_probs, bracket = cached_simulation(team_strength, data["fixtures"], simulations, int(seed))

if page == "Stage Probability Table":
    with st.spinner("Training stage-probability models..."):
        models = cached_models()
        model_probs = predict_stage_probabilities(models, team_strength)
        combined = model_probs.merge(sim_probs, on=["team", "group"], suffixes=("_model", "_sim"))

if page == "Data Sources and Refresh Status":
    st.subheader("Refresh Status")
    st.dataframe(source_table(data["sources"]), use_container_width=True, hide_index=True)
    st.subheader("2026 Groups")
    st.dataframe(data["groups"].sort_values(["group", "position"]), use_container_width=True, hide_index=True)
    warnings = [s.note for s in data["sources"] if s.status != "live"]
    if warnings:
        st.warning("Some sources are using cached or bundled fallback data. Review notes in the table before treating outputs as current.")

elif page == "Team Power Ratings":
    st.subheader("Team Power Ratings")
    cols = ["team", "group", "strength_score", "elo", "fifa_rank", "fifa_points", "market_value_m", "host", "attack", "defense"]
    st.dataframe(team_strength[cols], use_container_width=True, hide_index=True)
    st.bar_chart(team_strength.set_index("team")["strength_score"].head(20))

elif page == "Group Stage Simulator":
    st.subheader("Group Stage Inputs")
    group = st.selectbox("Group", sorted(data["groups"]["group"].unique()))
    st.dataframe(team_strength[team_strength["group"] == group][["team", "fifa_rank", "elo", "market_value_m", "attack", "defense"]], use_container_width=True, hide_index=True)
    st.subheader("Country A vs Country B")
    group_teams = sorted(team_strength[team_strength["group"] == group]["team"].tolist())
    col_a, col_b = st.columns(2)
    with col_a:
        team_a = st.selectbox("Country A", group_teams, index=0)
    with col_b:
        default_b = 1 if len(group_teams) > 1 else 0
        team_b = st.selectbox("Country B", group_teams, index=default_b)
    if team_a == team_b:
        st.info("Choose two different countries.")
    else:
        probs = match_result_probabilities(team_strength, team_a, team_b)
        m1, m2, m3 = st.columns(3)
        m1.metric(f"{team_a} win", f"{probs['team_a_win']:.1%}")
        m2.metric("Draw", f"{probs['draw']:.1%}")
        m3.metric(f"{team_b} win", f"{probs['team_b_win']:.1%}")
        st.caption(f"Expected goals: {team_a} {probs['team_a_expected_goals']:.2f} - {probs['team_b_expected_goals']:.2f} {team_b}")
    st.subheader("Scheduled Group Pairings")
    st.dataframe(data["fixtures"][data["fixtures"]["group"] == group], use_container_width=True, hide_index=True)

elif page == "Group Qualification Visual":
    st.subheader("Who May Make It Out Of Each Group")
    st.caption("Based on the Monte Carlo simulation count and seed in the sidebar. Raise simulations for smoother probabilities.")
    st.markdown(render_group_qualification(data["groups"], sim_probs), unsafe_allow_html=True)

elif page == "Animated Country Path":
    st.subheader("Animated Possible Country Path")
    sort_mode = st.radio(
        "Country order",
        ["A-Z order", "Z-A order", "Highest champion %"],
        horizontal=True,
    )
    if sort_mode == "Z-A order":
        countries = sorted(sim_probs["team"].tolist(), reverse=True)
    elif sort_mode == "Highest champion %":
        countries = sim_probs.sort_values(["Champion", "team"], ascending=[False, True])["team"].tolist()
    else:
        countries = sorted(sim_probs["team"].tolist())
    default_index = countries.index("Mexico") if "Mexico" in countries else 0
    selected_country = st.selectbox("Choose country", countries, index=default_index)
    country_group = team_strength.loc[team_strength["team"] == selected_country, "group"].iloc[0]
    st.caption(f"{selected_country} starts in Group {country_group}. Percentages come from the Monte Carlo simulations in the sidebar.")
    st.markdown(render_country_path(selected_country, sim_probs), unsafe_allow_html=True)
    st.subheader("One Sample Knockout Route")
    route = sampled_country_matches(selected_country, bracket)
    if route.empty:
        st.info(f"{selected_country} did not reach the Round of 32 in this sampled bracket seed. It may still have a non-zero probability across all simulations.")
    else:
        st.dataframe(route, use_container_width=True, hide_index=True)

elif page == "Round of 32 Fixtures":
    st.subheader("Round of 32 Fixture Analysis")
    r32 = analyze_round_of_32(team_strength, bracket)
    if r32.empty:
        st.info("Run a simulation to generate a Round of 32 bracket.")
    else:
        st.caption("These fixtures come from the currently selected simulation seed. Change the seed to inspect a different plausible bracket path.")
        display = r32[[
            "match", "fixture", "favorite", "favorite_win_probability",
            "team_a_expected_goals", "team_b_expected_goals", "strength_gap", "analysis",
        ]]
        st.dataframe(
            display.style.format({
                "favorite_win_probability": "{:.1%}",
                "team_a_expected_goals": "{:.2f}",
                "team_b_expected_goals": "{:.2f}",
                "strength_gap": "{:.1f}",
            }),
            use_container_width=True,
            hide_index=True,
        )
        top = r32.sort_values("favorite_win_probability", ascending=False).head(6)
        st.subheader("Biggest Favorite Edges")
        st.bar_chart(top.set_index("fixture")["favorite_win_probability"])

elif page == "Penalty Shootout Estimator":
    st.subheader("Penalty Shootout Estimator")
    st.caption("This is a team-level proxy. It does not yet ingest confirmed penalty takers, goalkeeper save rates, injuries, minutes played, or match-day fatigue.")
    penalty_table = build_penalty_table(team_strength)
    countries = penalty_table["team"].tolist()
    col1, col2 = st.columns(2)
    with col1:
        team_a = st.selectbox("Team A", countries, index=0)
    with col2:
        default_b = 1 if len(countries) > 1 else 0
        team_b = st.selectbox("Team B", countries, index=default_b)
    if team_a == team_b:
        st.info("Choose two different teams for a head-to-head penalty comparison.")
    else:
        p_a, p_b = penalty_head_to_head(penalty_table, team_a, team_b)
        c1, c2 = st.columns(2)
        c1.metric(f"{team_a} shootout win chance", f"{p_a:.1%}")
        c2.metric(f"{team_b} shootout win chance", f"{p_b:.1%}")
    st.subheader("Best Penalty Shootout Profiles")
    display = penalty_table[[
        "team", "group", "penalty_shootout_rating", "win_vs_average_penalty_team",
        "player_condition_proxy", "keeper_defense_proxy", "profile",
    ]].copy()
    st.dataframe(
        display.style.format({
            "penalty_shootout_rating": "{:.1f}",
            "win_vs_average_penalty_team": "{:.1%}",
            "player_condition_proxy": "{:.1f}",
            "keeper_defense_proxy": "{:.1f}",
        }),
        use_container_width=True,
        hide_index=True,
    )

elif page == "Bracket Path":
    st.subheader("Sample Simulated Bracket Path")
    st.dataframe(bracket, use_container_width=True, hide_index=True)

elif page == "Stage Probability Table":
    st.subheader("Model Ensemble vs Tournament Simulation")
    display = combined[[
        "team", "group", "Quarter-finals_model", "Semi-finals_model", "Final_model", "Champion_model",
        "Round of 32", "Quarter-finals_sim", "Semi-finals_sim", "Final_sim", "Champion_sim",
    ]].sort_values("Champion_sim", ascending=False)
    st.dataframe(display.style.format({c: "{:.1%}" for c in display.columns if c not in ["team", "group"]}), use_container_width=True, hide_index=True)

elif page == "Champion Odds":
    st.subheader("Most Likely Champions")
    top = sim_probs.head(16).copy()
    st.bar_chart(top.set_index("team")["Champion"])
    st.dataframe(top.style.format({c: "{:.1%}" for c in ["Round of 32", "Quarter-finals", "Semi-finals", "Final", "Champion"]}), use_container_width=True, hide_index=True)

elif page == "Model Validation":
    st.subheader("GroupKFold Validation by Held-Out World Cup Year")
    metrics, importances = cached_validation()
    st.dataframe(metrics.style.format({"log_loss": "{:.3f}", "brier": "{:.3f}", "positive_rate": "{:.1%}", "avg_probability": "{:.1%}"}), use_container_width=True, hide_index=True)
    st.subheader("Average Feature Importance")
    imp = importances.groupby("feature", as_index=False)["importance"].mean().sort_values("importance", ascending=False)
    st.bar_chart(imp.set_index("feature")["importance"])

else:
    st.subheader("Methodology and Caveats")
    st.markdown(
        """
This app combines FIFA ranking, an unofficial Elo signal, squad market value, host status, and historical tournament-stage features.
The Random Forest ensemble estimates stage probabilities, while the Monte Carlo engine simulates the 2026 group and knockout path.

Key caveats:
- Transfermarkt values are market estimates, not official sporting ratings.
- Elo is unofficial and may differ from FIFA's own ranking points.
- Live web sources can block automated retrieval; cached or seed data is clearly labeled in the source table.
- The third-place Round of 32 allocation is implemented as a deterministic approximation of the official slot constraints.
- Fair-play and full head-to-head tie-breakers are represented by placeholders; FIFA ranking fallback is active.
- The bundled historical training frame is a reproducible scaffold until a fully parsed historical match dataset is refreshed.
        """
    )
