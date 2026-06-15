from __future__ import annotations

import numpy as np
import pandas as pd

from .constants import HOSTS
from .data_fetch import seed_historical_stage_results, seed_rankings


def build_team_strength(groups: pd.DataFrame, rankings: pd.DataFrame, elo: pd.DataFrame, values: pd.DataFrame) -> pd.DataFrame:
    teams = groups[["team", "group"]].drop_duplicates()
    df = teams.merge(rankings, on="team", how="left").merge(elo, on="team", how="left").merge(values, on="team", how="left")
    for column in ["fifa_rank", "fifa_points", "elo", "market_value_m"]:
        if column not in df.columns:
            df[column] = np.nan
    seed = seed_rankings()[["team", "fifa_rank", "fifa_points"]].rename(columns={
        "fifa_rank": "fifa_rank_seed",
        "fifa_points": "fifa_points_seed",
    })
    df = df.merge(seed, on="team", how="left")
    df["fifa_rank"] = df["fifa_rank"].fillna(df["fifa_rank_seed"]).fillna(80)
    df["fifa_points"] = df["fifa_points"].fillna(df["fifa_points_seed"]).fillna(1350)
    df["elo"] = df["elo"].fillna(1800 - df["fifa_rank"] * 7)
    df["market_value_m"] = df["market_value_m"].fillna(125 * np.exp(-df["fifa_rank"] / 45)).clip(lower=12)
    df["host"] = df["team"].isin(HOSTS).astype(int)
    df["world_cup_experience"] = (9 - np.log1p(df["fifa_rank"])).clip(lower=0)
    df["knockout_index"] = (210 - df["fifa_rank"] * 3 + np.log1p(df["market_value_m"]) * 18).clip(lower=5)
    df["attack"] = (1.05 + (df["elo"] - 1600) / 900 + np.log1p(df["market_value_m"]) / 18).clip(0.55, 2.4)
    df["defense"] = (1.05 - (df["elo"] - 1600) / 1200 - np.log1p(df["market_value_m"]) / 26).clip(0.45, 1.45)
    df["strength_score"] = (
        (df["elo"] - df["elo"].min()) / (df["elo"].max() - df["elo"].min() + 1e-9) * 45
        + (1 - (df["fifa_rank"] - 1) / (df["fifa_rank"].max() - 1 + 1e-9)) * 30
        + np.log1p(df["market_value_m"]) / np.log1p(df["market_value_m"].max()) * 20
        + df["host"] * 5
    )
    return df.drop(columns=[c for c in ["fifa_rank_seed", "fifa_points_seed"] if c in df.columns]).sort_values("strength_score", ascending=False)


def make_training_frame() -> pd.DataFrame:
    labels = seed_historical_stage_results()
    ranks = seed_rankings()
    rows = []
    rng = np.random.default_rng(26)
    rank_map = dict(zip(ranks["team"], ranks["fifa_rank"]))
    for label in labels.itertuples():
            baseline = rank_map.get(label.team, 42)
            historical_boost = 0
            if label.team in {"Italy", "Germany", "Brazil", "Argentina", "France", "Spain", "Netherlands"}:
                historical_boost = -8
            drift = rng.normal(0, 6)
            rank = max(1, baseline + historical_boost + drift + (2022 - label.year) / 10)
            value = max(15, 1500 * np.exp(-rank / 20) + rng.normal(0, 25))
            elo = 2140 - rank * 22 + rng.normal(0, 35)
            rows.append({
                "year": label.year,
                "team": label.team,
                "fifa_rank": rank,
                "fifa_points": 1900 - rank * 7,
                "elo": elo,
                "market_value_m": value,
                "host": int(label.team in {1998: {"France"}, 2002: {"South Korea", "Japan"}, 2006: {"Germany"}, 2010: {"South Africa"}, 2014: {"Brazil"}, 2018: {"Russia"}, 2022: {"Qatar"}}.get(label.year, set())),
                "world_cup_experience": max(0, 8 - np.log1p(rank)),
                "knockout_index": max(0, 200 - rank * 3 + np.log1p(value) * 18),
                "reached_qf": label.reached_qf,
                "reached_sf": label.reached_sf,
                "reached_final": label.reached_final,
                "champion": label.champion,
            })
    return pd.DataFrame(rows)


FEATURE_COLUMNS = ["fifa_rank", "fifa_points", "elo", "market_value_m", "host", "world_cup_experience", "knockout_index"]
