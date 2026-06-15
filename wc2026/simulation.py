from __future__ import annotations

import math
from collections import Counter

import numpy as np
import pandas as pd

from .constants import KNOCKOUT_NEXT, ROUND_OF_32_SLOTS


def poisson_pmf(lam: float, k: int) -> float:
    return math.exp(-lam) * (lam ** k) / math.factorial(k)


def score_matrix(home_lam: float, away_lam: float, max_goals: int = 8) -> np.ndarray:
    matrix = np.zeros((max_goals + 1, max_goals + 1))
    for i in range(max_goals + 1):
        for j in range(max_goals + 1):
            matrix[i, j] = poisson_pmf(home_lam, i) * poisson_pmf(away_lam, j)
    return matrix / matrix.sum()


def matchup_win_probability(team_a: pd.Series, team_b: pd.Series) -> tuple[float, float, float, float]:
    a_lam, b_lam = expected_goals(team_a, team_b)
    matrix = score_matrix(a_lam, b_lam)
    a_regular = float(np.tril(matrix, -1).sum())
    b_regular = float(np.triu(matrix, 1).sum())
    draw = float(np.trace(matrix))
    strength_a = float(team_a["strength_score"])
    strength_b = float(team_b["strength_score"])
    penalty_a = 1 / (1 + np.exp(-(strength_a - strength_b) / 18))
    a_total = a_regular + draw * penalty_a
    b_total = b_regular + draw * (1 - penalty_a)
    return a_lam, b_lam, a_total, b_total


def expected_goals(team_a: pd.Series, team_b: pd.Series, neutral: bool = True) -> tuple[float, float]:
    home_boost = 0.05 if not neutral else 0
    a = float((team_a["attack"] + team_b["defense"]) / 2 + home_boost)
    b = float((team_b["attack"] + team_a["defense"]) / 2)
    return max(0.25, a), max(0.25, b)


def simulate_score(team_a: pd.Series, team_b: pd.Series, rng: np.random.Generator) -> tuple[int, int]:
    a_lam, b_lam = expected_goals(team_a, team_b)
    return int(rng.poisson(a_lam)), int(rng.poisson(b_lam))


def knockout_winner(team_a: pd.Series, team_b: pd.Series, rng: np.random.Generator) -> str:
    team_a_name = str(team_a.name)
    team_b_name = str(team_b.name)
    a_goals, b_goals = simulate_score(team_a, team_b, rng)
    if a_goals > b_goals:
        return team_a_name
    if b_goals > a_goals:
        return team_b_name
    strength_a = float(team_a["strength_score"])
    strength_b = float(team_b["strength_score"])
    p_a = 1 / (1 + np.exp(-(strength_a - strength_b) / 18))
    return team_a_name if rng.random() < p_a else team_b_name


def rank_group(table: list[dict]) -> list[dict]:
    return sorted(
        table,
        key=lambda r: (r["pts"], r["gd"], r["gf"], -r["fifa_rank"]),
        reverse=True,
    )


def simulate_group_stage(teams: pd.DataFrame, fixtures: pd.DataFrame, rng: np.random.Generator):
    by_team = teams.set_index("team")
    standings = {}
    qualifiers = {}
    third_rows = []
    for group, group_fixtures in fixtures.groupby("group"):
        table = {team: {"team": team, "group": group, "pts": 0, "gf": 0, "ga": 0, "gd": 0, "fifa_rank": float(by_team.loc[team, "fifa_rank"])} for team in set(group_fixtures["home"]) | set(group_fixtures["away"])}
        for match in group_fixtures.itertuples():
            hg, ag = simulate_score(by_team.loc[match.home], by_team.loc[match.away], rng)
            table[match.home]["gf"] += hg
            table[match.home]["ga"] += ag
            table[match.away]["gf"] += ag
            table[match.away]["ga"] += hg
            if hg > ag:
                table[match.home]["pts"] += 3
            elif ag > hg:
                table[match.away]["pts"] += 3
            else:
                table[match.home]["pts"] += 1
                table[match.away]["pts"] += 1
        for row in table.values():
            row["gd"] = row["gf"] - row["ga"]
        ranked = rank_group(list(table.values()))
        standings[group] = ranked
        qualifiers[f"1{group}"] = ranked[0]["team"]
        qualifiers[f"2{group}"] = ranked[1]["team"]
        third_rows.append(ranked[2])
    thirds = rank_group(third_rows)[:8]
    for row in thirds:
        qualifiers[f"3{row['group']}"] = row["team"]
    return standings, qualifiers


def _resolve_slot(slot: str, qualifiers: dict[str, str], used_thirds: set[str]) -> str:
    if "/" not in slot:
        return qualifiers[slot]
    candidates = slot[1:].split("/")
    for group in candidates:
        key = f"3{group}"
        if key in qualifiers and key not in used_thirds:
            used_thirds.add(key)
            return qualifiers[key]
    remaining = [k for k in qualifiers if k.startswith("3") and k not in used_thirds]
    if not remaining:
        raise ValueError(f"No third-place qualifier available for {slot}")
    used_thirds.add(remaining[0])
    return qualifiers[remaining[0]]


def simulate_knockouts(teams: pd.DataFrame, qualifiers: dict[str, str], rng: np.random.Generator):
    by_team = teams.set_index("team")
    winners = {}
    bracket_rows = []
    used_thirds: set[str] = set()
    for match_id, left_slot, right_slot in ROUND_OF_32_SLOTS:
        left = _resolve_slot(left_slot, qualifiers, used_thirds)
        right = _resolve_slot(right_slot, qualifiers, used_thirds)
        winner = knockout_winner(by_team.loc[left], by_team.loc[right], rng)
        winners[f"W{match_id[1:]}"] = winner
        bracket_rows.append({"round": "Round of 32", "match": match_id, "team_a": left, "team_b": right, "winner": winner})
    for round_name, matches in KNOCKOUT_NEXT.items():
        for match_id, left_key, right_key in matches:
            left = winners[left_key]
            right = winners[right_key]
            winner = knockout_winner(by_team.loc[left], by_team.loc[right], rng)
            winners[f"W{match_id[1:]}"] = winner
            bracket_rows.append({"round": round_name, "match": match_id, "team_a": left, "team_b": right, "winner": winner})
    return winners["W104"], bracket_rows


def run_monte_carlo(teams: pd.DataFrame, fixtures: pd.DataFrame, n: int = 2000, seed: int = 26):
    rng = np.random.default_rng(seed)
    counts = {stage: Counter() for stage in ["Round of 32", "Quarter-finals", "Semi-finals", "Final", "Champion"]}
    last_bracket = []
    for _ in range(n):
        _, qualifiers = simulate_group_stage(teams, fixtures, rng)
        for team in qualifiers.values():
            counts["Round of 32"][team] += 1
        champion, bracket = simulate_knockouts(teams, qualifiers, rng)
        last_bracket = bracket
        for row in bracket:
            if row["round"] == "Round of 32":
                continue
            if row["round"] == "QF":
                counts["Quarter-finals"][row["team_a"]] += 1
                counts["Quarter-finals"][row["team_b"]] += 1
            elif row["round"] == "SF":
                counts["Semi-finals"][row["team_a"]] += 1
                counts["Semi-finals"][row["team_b"]] += 1
            elif row["round"] == "Final":
                counts["Final"][row["team_a"]] += 1
                counts["Final"][row["team_b"]] += 1
        counts["Champion"][champion] += 1
    rows = []
    for team in teams["team"]:
        row = {"team": team, "group": teams.loc[teams["team"] == team, "group"].iloc[0]}
        for stage, counter in counts.items():
            row[stage] = counter[team] / n
        rows.append(row)
    return pd.DataFrame(rows).sort_values("Champion", ascending=False), pd.DataFrame(last_bracket)


def analyze_round_of_32(teams: pd.DataFrame, bracket: pd.DataFrame) -> pd.DataFrame:
    by_team = teams.set_index("team")
    rows = []
    r32 = bracket[bracket["round"] == "Round of 32"].copy()
    for match in r32.itertuples():
        team_a = by_team.loc[match.team_a]
        team_b = by_team.loc[match.team_b]
        a_xg, b_xg, a_win, b_win = matchup_win_probability(team_a, team_b)
        favorite = match.team_a if a_win >= b_win else match.team_b
        underdog = match.team_b if favorite == match.team_a else match.team_a
        favorite_prob = max(a_win, b_win)
        gap = abs(float(team_a["strength_score"]) - float(team_b["strength_score"]))
        if favorite_prob >= 0.68:
            note = f"{favorite} is a clear favorite; {underdog} likely needs a low-scoring match or penalties."
        elif favorite_prob >= 0.58:
            note = f"{favorite} has the edge, but the matchup is close enough for tactical swings."
        else:
            note = "Very balanced fixture; penalties and small goal-margin events matter a lot."
        rows.append({
            "match": match.match,
            "fixture": f"{match.team_a} vs {match.team_b}",
            "team_a": match.team_a,
            "team_b": match.team_b,
            "favorite": favorite,
            "favorite_win_probability": favorite_prob,
            "team_a_win_probability": a_win,
            "team_b_win_probability": b_win,
            "team_a_expected_goals": a_xg,
            "team_b_expected_goals": b_xg,
            "strength_gap": gap,
            "analysis": note,
        })
    return pd.DataFrame(rows)
