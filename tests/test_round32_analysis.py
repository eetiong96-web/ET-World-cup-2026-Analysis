from wc2026.data_fetch import build_group_fixtures, seed_groups, seed_rankings, seed_values
from wc2026.features import build_team_strength
from wc2026.simulation import analyze_round_of_32, run_monte_carlo


def test_round_of_32_analysis_has_fixture_probabilities():
    groups = seed_groups()
    fixtures = build_group_fixtures(groups)
    rankings = seed_rankings()
    values = seed_values()
    elo = rankings.assign(elo=2000 - rankings["fifa_rank"] * 10)[["team", "elo"]]
    teams = build_team_strength(groups, rankings, elo, values)
    _, bracket = run_monte_carlo(teams, fixtures, n=10, seed=9)

    analysis = analyze_round_of_32(teams, bracket)

    assert len(analysis) == 16
    assert analysis["favorite_win_probability"].between(0, 1).all()
    assert analysis["analysis"].str.len().min() > 20
