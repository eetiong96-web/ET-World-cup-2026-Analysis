import pandas as pd

from build_static import apply_live_result_adjustments
from wc2026.data_fetch import build_group_fixtures, parse_money_to_millions, seed_groups, seed_rankings, seed_values
from wc2026.features import build_team_strength, make_training_frame
from wc2026.models import validate_groupkfold
from wc2026.simulation import poisson_pmf, rank_group, run_monte_carlo


def test_money_parser():
    assert parse_money_to_millions("€1.52bn") == 1520
    assert parse_money_to_millions("€782.50m") == 782.5


def test_group_fixture_count():
    fixtures = build_group_fixtures(seed_groups())
    assert len(fixtures) == 72
    assert fixtures.groupby("group").size().eq(6).all()


def test_rank_group_uses_points_goal_difference_and_fifa_fallback():
    ranked = rank_group([
        {"team": "A", "pts": 4, "gd": 1, "gf": 2, "fifa_rank": 10},
        {"team": "B", "pts": 4, "gd": 1, "gf": 3, "fifa_rank": 30},
        {"team": "C", "pts": 1, "gd": -2, "gf": 1, "fifa_rank": 1},
    ])
    assert ranked[0]["team"] == "B"


def test_poisson_distribution_is_valid():
    total = sum(poisson_pmf(1.4, k) for k in range(20))
    assert 0.999 < total < 1.001


def test_groupkfold_holds_out_years():
    metrics, _ = validate_groupkfold(make_training_frame())
    assert metrics["held_out_year"].nunique() >= 5
    assert {"Quarter-finals", "Semi-finals", "Final", "Champion"}.issubset(set(metrics["target"]))


def test_monte_carlo_one_champion_probability_mass():
    groups = seed_groups()
    fixtures = build_group_fixtures(groups)
    rankings = seed_rankings()
    values = seed_values()
    elo = rankings.assign(elo=2000 - rankings["fifa_rank"] * 10)[["team", "elo"]]
    teams = build_team_strength(groups, rankings, elo, values)
    probs, bracket = run_monte_carlo(teams, fixtures, n=25, seed=3)
    assert abs(probs["Champion"].sum() - 1) < 1e-9
    assert not bracket.empty


def test_team_strength_uses_seed_rankings_when_live_rankings_have_no_rank_columns():
    groups = seed_groups()
    rankings = pd.DataFrame({"team": groups["team"].unique()})
    values = seed_values()
    elo = pd.DataFrame({"team": groups["team"].unique()})

    teams = build_team_strength(groups, rankings, elo, values)

    assert {"fifa_rank", "fifa_points", "elo", "market_value_m"}.issubset(teams.columns)
    assert teams["fifa_rank"].notna().all()


def test_live_result_adjustment_nudges_completed_match_winner():
    groups = seed_groups()
    rankings = seed_rankings()
    values = seed_values()
    elo = rankings.assign(elo=2000 - rankings["fifa_rank"] * 10)[["team", "elo"]]
    teams = build_team_strength(groups, rankings, elo, values)
    before = float(teams.loc[teams["team"] == "Mexico", "strength_score"].iloc[0])
    live = pd.DataFrame([{
        "home": "Mexico",
        "away": "South Africa",
        "home_score": 4,
        "away_score": 0,
        "completed": True,
    }])

    adjusted = apply_live_result_adjustments(teams, live)
    mexico = adjusted.loc[adjusted["team"] == "Mexico"].iloc[0]

    assert mexico["strength_score"] > before
    assert mexico["live_matches_played"] == 1
    assert bool(mexico["adjusted_by_live_results"]) is True
