from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from wc2026.data_fetch import load_all_data, source_table
from wc2026.features import build_team_strength, make_training_frame
from wc2026.models import predict_stage_probabilities, train_stage_models, validate_groupkfold
from wc2026.simulation import analyze_round_of_32, expected_goals, run_monte_carlo, score_matrix

ROOT = Path(__file__).parent
PUBLIC = ROOT / "public"
STATIC = ROOT / "static_site"
LIVE_RESULTS_REFRESH_MINUTES = 5
MODEL_REFRESH_HOURS = 8


def scale_0_100(series: pd.Series, higher_is_better: bool = True) -> pd.Series:
    values = series.astype(float)
    span = values.max() - values.min()
    scaled = pd.Series(50.0, index=series.index) if span == 0 else (values - values.min()) / span * 100
    return scaled if higher_is_better else 100 - scaled


def penalty_profile(score: float) -> str:
    if score >= 72:
        return "Elite shootout profile"
    if score >= 58:
        return "Strong shootout profile"
    if score >= 44:
        return "Competitive shootout profile"
    return "Risky shootout profile"


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
    table["win_vs_average_penalty_team"] = 1 / (1 + np.exp(-(table["penalty_shootout_rating"] - 50) / 12))
    table["profile"] = table["penalty_shootout_rating"].map(penalty_profile)
    return table.sort_values("penalty_shootout_rating", ascending=False)


def match_result_table(team_strength: pd.DataFrame) -> pd.DataFrame:
    by_team = team_strength.set_index("team")
    rows = []
    for group, frame in team_strength.groupby("group"):
        teams = sorted(frame["team"].tolist())
        for team_a in teams:
            for team_b in teams:
                if team_a == team_b:
                    continue
                a_row = by_team.loc[team_a]
                b_row = by_team.loc[team_b]
                a_xg, b_xg = expected_goals(a_row, b_row)
                matrix = score_matrix(a_xg, b_xg, max_goals=8)
                rows.append(
                    {
                        "group": group,
                        "team_a": team_a,
                        "team_b": team_b,
                        "team_a_expected_goals": a_xg,
                        "team_b_expected_goals": b_xg,
                        "team_a_win": float(matrix[np.tril_indices_from(matrix, -1)].sum()),
                        "draw": float(matrix.diagonal().sum()),
                        "team_b_win": float(matrix[np.triu_indices_from(matrix, 1)].sum()),
                    }
                )
    return pd.DataFrame(rows)


def group_goal_projection(fixtures: pd.DataFrame, team_strength: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    by_team = team_strength.set_index("team")
    match_rows = []
    totals: dict[str, dict[str, float | str]] = {}
    for match in fixtures.itertuples():
        home = by_team.loc[match.home]
        away = by_team.loc[match.away]
        home_xg, away_xg = expected_goals(home, away)
        total = home_xg + away_xg
        match_rows.append(
            {
                "group": match.group,
                "match_id": match.match_id,
                "home": match.home,
                "away": match.away,
                "home_expected_goals": home_xg,
                "away_expected_goals": away_xg,
                "total_expected_goals": total,
            }
        )
        for team, goals_for, goals_against in [(match.home, home_xg, away_xg), (match.away, away_xg, home_xg)]:
            current = totals.setdefault(team, {"team": team, "group": match.group, "expected_goals_for": 0.0, "expected_goals_against": 0.0})
            current["expected_goals_for"] = float(current["expected_goals_for"]) + goals_for
            current["expected_goals_against"] = float(current["expected_goals_against"]) + goals_against
    total_rows = []
    for row in totals.values():
        row["expected_goal_difference"] = float(row["expected_goals_for"]) - float(row["expected_goals_against"])
        total_rows.append(row)
    return pd.DataFrame(match_rows), pd.DataFrame(total_rows).sort_values(["group", "expected_goals_for"], ascending=[True, False])


def current_group_tables(groups: pd.DataFrame, live_results: pd.DataFrame) -> pd.DataFrame:
    rows = []
    team_to_group = dict(zip(groups["team"], groups["group"]))
    table = {
        team: {"group": group, "team": team, "played": 0, "won": 0, "drawn": 0, "lost": 0, "goals_for": 0, "goals_against": 0, "goal_difference": 0, "points": 0}
        for team, group in team_to_group.items()
    }
    if not live_results.empty:
        completed = live_results[live_results["completed"].astype(bool, errors="ignore") == True].copy()
        for match in completed.itertuples():
            home = getattr(match, "home", None)
            away = getattr(match, "away", None)
            if home not in table or away not in table:
                continue
            try:
                home_score = int(float(getattr(match, "home_score")))
                away_score = int(float(getattr(match, "away_score")))
            except (TypeError, ValueError):
                continue
            table[home]["played"] += 1
            table[away]["played"] += 1
            table[home]["goals_for"] += home_score
            table[home]["goals_against"] += away_score
            table[away]["goals_for"] += away_score
            table[away]["goals_against"] += home_score
            if home_score > away_score:
                table[home]["won"] += 1
                table[home]["points"] += 3
                table[away]["lost"] += 1
            elif away_score > home_score:
                table[away]["won"] += 1
                table[away]["points"] += 3
                table[home]["lost"] += 1
            else:
                table[home]["drawn"] += 1
                table[away]["drawn"] += 1
                table[home]["points"] += 1
                table[away]["points"] += 1
    for row in table.values():
        row["goal_difference"] = row["goals_for"] - row["goals_against"]
        rows.append(row)
    return pd.DataFrame(rows).sort_values(["group", "points", "goal_difference", "goals_for"], ascending=[True, False, False, False])


def current_match_points(fixtures: pd.DataFrame, live_results: pd.DataFrame) -> pd.DataFrame:
    result_lookup: dict[tuple[str, str], dict] = {}
    if not live_results.empty:
        for row in live_results.to_dict("records"):
            home = row.get("home")
            away = row.get("away")
            if home and away:
                result_lookup[(home, away)] = row
                result_lookup[(away, home)] = {
                    **row,
                    "home": away,
                    "away": home,
                    "home_score": row.get("away_score"),
                    "away_score": row.get("home_score"),
                }
    rows = []
    for match in fixtures.itertuples():
        result = result_lookup.get((match.home, match.away), {})
        completed = bool(result.get("completed"))
        home_score = result.get("home_score")
        away_score = result.get("away_score")
        home_points = ""
        away_points = ""
        score = "TBD"
        if completed:
            try:
                home_score_i = int(float(home_score))
                away_score_i = int(float(away_score))
                score = f"{home_score_i}-{away_score_i}"
                if home_score_i > away_score_i:
                    home_points, away_points = 3, 0
                elif away_score_i > home_score_i:
                    home_points, away_points = 0, 3
                else:
                    home_points, away_points = 1, 1
            except (TypeError, ValueError):
                completed = False
                score = "TBD"
        rows.append(
            {
                "group": match.group,
                "match_id": match.match_id,
                "home": match.home,
                "away": match.away,
                "score": score,
                "home_points": home_points,
                "away_points": away_points,
                "status": result.get("status") or "Scheduled",
                "date": result.get("date") or "",
                "completed": completed,
            }
        )
    return pd.DataFrame(rows).sort_values(["group", "match_id"])


def clean_records(df: pd.DataFrame) -> list[dict]:
    if df.empty:
        return []
    cleaned = df.replace({np.nan: None})
    return json.loads(cleaned.to_json(orient="records"))


def write_static_assets() -> None:
    PUBLIC.mkdir(exist_ok=True)
    (PUBLIC / "styles.css").write_text((STATIC / "styles.css").read_text(encoding="utf-8"), encoding="utf-8")
    (PUBLIC / "app.js").write_text((STATIC / "app.js").read_text(encoding="utf-8"), encoding="utf-8")
    (PUBLIC / "_headers").write_text(
        "/*\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: strict-origin-when-cross-origin\n"
        "/data.json\n"
        "  Cache-Control: no-cache, max-age=0\n",
        encoding="utf-8",
    )


def main() -> None:
    data = load_all_data()
    team_strength = build_team_strength(data["groups"], data["rankings"], data["elo"], data["values"])
    models = train_stage_models(make_training_frame())
    model_probs = predict_stage_probabilities(models, team_strength)
    validation, importances = validate_groupkfold(make_training_frame())
    goal_matches, goal_totals = group_goal_projection(data["fixtures"], team_strength)
    simulation_options = {"counts": [10000], "seeds": [999], "default_count": 10000, "default_seed": 999}
    simulations = {}
    for count in simulation_options["counts"]:
        for seed in simulation_options["seeds"]:
            sim_probs, bracket = run_monte_carlo(team_strength, data["fixtures"], n=count, seed=seed)
            key = f"{count}-{seed}"
            simulations[key] = {
                "count": count,
                "seed": seed,
                "simulation_probabilities": clean_records(sim_probs),
                "bracket": clean_records(bracket),
                "round32_analysis": clean_records(analyze_round_of_32(team_strength, bracket)),
            }
    default_key = f"{simulation_options['default_count']}-{simulation_options['default_seed']}"
    default_sim = simulations[default_key]

    payload = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "refresh_cadences": {
            "live_results_minutes": LIVE_RESULTS_REFRESH_MINUTES,
            "transfermarkt_values_hours": MODEL_REFRESH_HOURS,
            "model_refresh_hours": MODEL_REFRESH_HOURS,
        },
        "simulation_count": simulation_options["default_count"],
        "simulation_seed": simulation_options["default_seed"],
        "simulation_options": simulation_options,
        "simulations": simulations,
        "sources": clean_records(source_table(data["sources"])),
        "live_results": clean_records(data["live_results"]),
        "current_group_tables": clean_records(current_group_tables(data["groups"], data["live_results"])),
        "groups": clean_records(data["groups"].sort_values(["group", "position"])),
        "fixtures": clean_records(data["fixtures"]),
        "team_strength": clean_records(team_strength),
        "simulation_probabilities": default_sim["simulation_probabilities"],
        "model_probabilities": clean_records(model_probs),
        "bracket": default_sim["bracket"],
        "round32_analysis": default_sim["round32_analysis"],
        "matchups": clean_records(match_result_table(team_strength)),
        "goal_matches": clean_records(goal_matches),
        "goal_totals": clean_records(goal_totals),
        "penalties": clean_records(build_penalty_table(team_strength)),
        "validation": clean_records(validation),
        "feature_importance": clean_records(importances.groupby("feature", as_index=False)["importance"].mean().sort_values("importance", ascending=False)),
    }

    write_static_assets()
    (PUBLIC / "data.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (PUBLIC / "index.html").write_text(
        """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>World Cup 2026 Analysis Generator</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <aside class="sidebar">
    <h2>Controls</h2>
    <p class="muted">Static Cloudflare Pages build</p>
    <nav id="nav"></nav>
  </aside>
  <main class="main">
    <header class="hero">
      <h1>World Cup 2026 Analysis Generator</h1>
      <p id="build-meta" class="muted">Loading...</p>
      <div id="refresh-meta" class="refresh-pill">Checking refresh timer...</div>
    </header>
    <section id="content"></section>
  </main>
  <script src="app.js"></script>
</body>
</html>
""",
        encoding="utf-8",
    )
    print(f"Static site built at {PUBLIC}")


if __name__ == "__main__":
    main()
