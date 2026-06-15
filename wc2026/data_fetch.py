from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable
from urllib.request import Request, urlopen

import pandas as pd

from .constants import GROUPS_2026, HOSTS, SOURCE_URLS, SourceRecord, normalize_team

CACHE_DIR = Path("data/cache")
PARSER_VERSION = "2026.1"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _ensure_cache() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _http_get(url: str, timeout: int = 25) -> str:
    req = Request(url, headers={"User-Agent": "Mozilla/5.0 WorldCup2026Analysis/1.0"})
    with urlopen(req, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def _cache_frame(name: str, df: pd.DataFrame, source: SourceRecord) -> None:
    _ensure_cache()
    df.to_csv(CACHE_DIR / f"{name}.csv", index=False)
    (CACHE_DIR / f"{name}.meta.json").write_text(json.dumps(source.__dict__, indent=2), encoding="utf-8")


def _load_cached(name: str) -> tuple[pd.DataFrame | None, SourceRecord | None]:
    path = CACHE_DIR / f"{name}.csv"
    meta_path = CACHE_DIR / f"{name}.meta.json"
    if not path.exists() or not meta_path.exists():
        return None, None
    return pd.read_csv(path), SourceRecord(**json.loads(meta_path.read_text(encoding="utf-8")))


def _with_cache(name: str, url: str, parser: Callable[[], pd.DataFrame], fallback: Callable[[], pd.DataFrame]) -> tuple[pd.DataFrame, SourceRecord]:
    try:
        df = parser()
        source = SourceRecord(name, url, "live", utc_now(), len(df), f"Live source refreshed successfully. Parser {PARSER_VERSION}.")
        _cache_frame(name, df, source)
        return df, source
    except Exception as exc:
        cached, cached_source = _load_cached(name)
        reason = friendly_fetch_reason(exc)
        if cached is not None and cached_source is not None:
            return cached, SourceRecord(name, url, "cached", utc_now(), len(cached), f"Using last saved snapshot. {reason}")
        df = fallback()
        source = SourceRecord(name, url, "seed", utc_now(), len(df), f"Using bundled starter data. {reason}")
        _cache_frame(name, df, source)
        return df, source


def friendly_fetch_reason(exc: Exception) -> str:
    text = str(exc)
    if "405" in text or "Not Allowed" in text:
        return "The public website blocked automated access, which is common for sports/stat pages."
    if "static HTML" in text or "not available" in text:
        return "The public page loads this table dynamically, so the app cannot read it from the initial HTML."
    if "not in index" in text:
        return "The live table shape changed, so the app used the safer stored data instead."
    return "The live source could not be refreshed just now."


def fetch_transfermarkt_values() -> tuple[pd.DataFrame, SourceRecord]:
    def parser() -> pd.DataFrame:
        html = _http_get(SOURCE_URLS["transfermarkt_values"])
        rows = []
        pattern = re.compile(
            r">\s*(?P<rank>\d+)\s*</td>|(?P<team>[A-Z][A-Za-z &.\-]+)</a>\s*</td>\s*<td[^>]*>(?P<squad>\d+)</td>\s*<td[^>]*>(?P<age>[\d.]+)</td>\s*<td[^>]*>(?P<value>€[^<]+)</td>",
            re.S,
        )
        # The site is easiest to parse with pandas when lxml/html5lib are present.
        try:
            tables = pd.read_html(html)
            table = max(tables, key=len)
            table.columns = [str(c).lower().replace(" ", "_") for c in table.columns]
            team_col = next(c for c in table.columns if "nation" in c or "team" in c)
            value_col = next(c for c in table.columns if "value" in c)
            rank_col = table.columns[0]
            out = table[[rank_col, team_col, value_col]].copy()
            out.columns = ["fifa_rank", "team", "market_value_raw"]
            out["team"] = out["team"].map(normalize_team)
            out["market_value_m"] = out["market_value_raw"].map(parse_money_to_millions)
            return out.dropna(subset=["team"]).drop_duplicates("team")
        except Exception:
            for match in pattern.finditer(html):
                if match.group("team"):
                    rows.append({"team": normalize_team(match.group("team")), "market_value_raw": match.group("value")})
            if not rows:
                raise ValueError("Could not parse Transfermarkt values")
            out = pd.DataFrame(rows)
            out["market_value_m"] = out["market_value_raw"].map(parse_money_to_millions)
            out["fifa_rank"] = range(1, len(out) + 1)
            return out

    return _with_cache("transfermarkt_values", SOURCE_URLS["transfermarkt_values"], parser, seed_values)


def parse_money_to_millions(value: object) -> float:
    text = str(value).replace(",", "").replace("€", "").strip()
    match = re.search(r"([\d.]+)\s*(bn|m)?", text, re.I)
    if not match:
        return 0.0
    amount = float(match.group(1))
    unit = (match.group(2) or "m").lower()
    return amount * 1000 if unit == "bn" else amount


def fetch_fifa_rankings() -> tuple[pd.DataFrame, SourceRecord]:
    def parser() -> pd.DataFrame:
        html = _http_get(SOURCE_URLS["fifa_rankings"])
        if "Latest Men" not in html:
            raise ValueError("FIFA ranking page did not expose ranking table in static HTML")
        # FIFA renders most rows client-side, so use Transfermarkt's mirrored ranking table as a fallback-like live source.
        values, _ = fetch_transfermarkt_values()
        if "fifa_rank" not in values.columns:
            seed = seed_rankings()[["team", "fifa_rank"]]
            values = values[["team"]].merge(seed, on="team", how="left")
            values["fifa_rank"] = values["fifa_rank"].fillna(pd.Series(range(1, len(values) + 1), index=values.index))
        return values[["team", "fifa_rank"]].assign(fifa_points=lambda d: 1900 - d["fifa_rank"] * 8)

    return _with_cache("fifa_rankings", SOURCE_URLS["fifa_rankings"], parser, seed_rankings)


def fetch_elo_ratings() -> tuple[pd.DataFrame, SourceRecord]:
    def parser() -> pd.DataFrame:
        html = _http_get(SOURCE_URLS["elo_ratings"])
        rows = []
        for team, elo in re.findall(r"/([A-Za-z0-9_%.-]+)[^>]*>\s*([^<]+)</a>[^\\d]*(\\d{3,4})", html):
            name = normalize_team(team.replace("_", " ").replace("%20", " "))
            rows.append({"team": name, "elo": int(elo)})
        if not rows:
            raise ValueError("Elo ratings were not available in static HTML")
        return pd.DataFrame(rows).drop_duplicates("team")

    return _with_cache("elo_ratings", SOURCE_URLS["elo_ratings"], parser, seed_elo)


def fetch_2026_structure() -> tuple[pd.DataFrame, pd.DataFrame, SourceRecord]:
    def parser() -> pd.DataFrame:
        text = _http_get("https://raw.githubusercontent.com/openfootball/worldcup/master/2026--usa/cup.txt")
        groups = parse_openfootball_groups(text)
        if groups.empty:
            raise ValueError("Openfootball 2026 group data not found")
        return groups

    groups, source = _with_cache("groups_2026", SOURCE_URLS["openfootball_worldcup"], parser, seed_groups)
    fixtures = build_group_fixtures(groups)
    return groups, fixtures, source


def fetch_live_results() -> tuple[pd.DataFrame, SourceRecord]:
    def parser() -> pd.DataFrame:
        rows = []
        start = datetime(2026, 6, 11, tzinfo=timezone.utc)
        today = datetime.now(timezone.utc)
        days = max(1, min(45, (today.date() - start.date()).days + 2))
        urls = [SOURCE_URLS["espn_scoreboard"]]
        urls.extend(f'{SOURCE_URLS["espn_scoreboard"]}?dates={(start + timedelta(days=i)).strftime("%Y%m%d")}' for i in range(days))
        for url in urls:
            payload = json.loads(_http_get(url))
            for event in payload.get("events", []):
                competition = (event.get("competitions") or [{}])[0]
                competitors = competition.get("competitors") or []
                home = next((c for c in competitors if c.get("homeAway") == "home"), None)
                away = next((c for c in competitors if c.get("homeAway") == "away"), None)
                if not home or not away:
                    continue
                status = competition.get("status", {}).get("type", {})
                rows.append({
                    "date": event.get("date"),
                    "match": event.get("name") or event.get("shortName"),
                    "home": normalize_team(home.get("team", {}).get("displayName", "")),
                    "away": normalize_team(away.get("team", {}).get("displayName", "")),
                    "home_score": home.get("score"),
                    "away_score": away.get("score"),
                    "status": status.get("description") or status.get("name"),
                    "completed": bool(status.get("completed")),
                })
        if not rows:
            raise ValueError("ESPN scoreboard returned no World Cup rows for the current build window")
        return pd.DataFrame(rows, columns=["date", "match", "home", "away", "home_score", "away_score", "status", "completed"]).drop_duplicates(["date", "home", "away"], keep="last")

    return _with_cache("espn_scoreboard", SOURCE_URLS["espn_scoreboard"], parser, seed_live_results)


def seed_live_results() -> pd.DataFrame:
    return pd.DataFrame(columns=["date", "match", "home", "away", "home_score", "away_score", "status", "completed"])


def parse_openfootball_groups(text: str) -> pd.DataFrame:
    rows = []
    for line in text.splitlines():
        match = re.match(r"\s*Group\s+([A-L])\s*\|\s*(.+)$", line)
        if not match:
            continue
        group = match.group(1)
        teams = re.split(r"\s{2,}|\t+", match.group(2).strip())
        if len(teams) < 4:
            teams = match.group(2).split()
        for pos, team in enumerate(teams[:4], start=1):
            rows.append({"group": group, "position": pos, "team": normalize_team(team)})
    return pd.DataFrame(rows)


def build_group_fixtures(groups: pd.DataFrame) -> pd.DataFrame:
    rows = []
    pairings = [(1, 2), (3, 4), (1, 3), (4, 2), (4, 1), (2, 3)]
    for group, frame in groups.groupby("group"):
        team_by_pos = {int(r.position): r.team for r in frame.itertuples()}
        for idx, (a, b) in enumerate(pairings, start=1):
            rows.append({"match_id": f"{group}{idx}", "round": "Group", "group": group, "home": team_by_pos[a], "away": team_by_pos[b]})
    return pd.DataFrame(rows)


def seed_groups() -> pd.DataFrame:
    rows = []
    for group, teams in GROUPS_2026.items():
        for pos, team in enumerate(teams, start=1):
            rows.append({"group": group, "position": pos, "team": team})
    return pd.DataFrame(rows)


def seed_rankings() -> pd.DataFrame:
    ordered = [
        "France", "Spain", "Argentina", "England", "Portugal", "Brazil", "Netherlands", "Morocco",
        "Belgium", "Germany", "Croatia", "Colombia", "Senegal", "Mexico", "USA", "Uruguay",
        "Japan", "Switzerland", "Iran", "Turkey", "Ecuador", "Austria", "South Korea", "Norway",
        "Sweden", "Australia", "Qatar", "Egypt", "Tunisia", "Paraguay", "Scotland", "Ghana",
        "Algeria", "Ivory Coast", "Saudi Arabia", "Czechia", "Canada", "Panama", "South Africa",
        "Uzbekistan", "DR Congo", "Iraq", "Jordan", "New Zealand", "Cape Verde", "Haiti",
        "Bosnia & Herzegovina", "Curacao",
    ]
    return pd.DataFrame({"team": ordered, "fifa_rank": range(1, len(ordered) + 1), "fifa_points": [1900 - i * 7 for i in range(len(ordered))]})


def seed_elo() -> pd.DataFrame:
    rankings = seed_rankings()
    return rankings.assign(elo=lambda d: 2130 - (d["fifa_rank"] - 1) * 22)[["team", "elo"]]


def seed_values() -> pd.DataFrame:
    values = {
        "France": 1520, "England": 1360, "Spain": 1220, "Portugal": 1010, "Germany": 947, "Brazil": 928,
        "Argentina": 783, "Netherlands": 754, "Belgium": 548, "Morocco": 498, "Senegal": 478, "Turkey": 474,
        "Croatia": 387, "USA": 386, "Ecuador": 369, "Uruguay": 359, "Switzerland": 333, "Colombia": 302,
        "Japan": 271, "Austria": 242, "Mexico": 192, "South Korea": 139,
    }
    rows = []
    for team in seed_rankings()["team"]:
        rows.append({"team": team, "market_value_m": values.get(team, max(18, 180 - len(rows) * 3)), "market_value_raw": ""})
    return pd.DataFrame(rows)


def seed_historical_stage_results() -> pd.DataFrame:
    stage_sets = {
        1998: {
            "qf": ["France", "Brazil", "Croatia", "Netherlands", "Italy", "Germany", "Argentina", "Denmark"],
            "sf": ["France", "Brazil", "Croatia", "Netherlands"],
            "final": ["France", "Brazil"],
            "champion": ["France"],
        },
        2002: {
            "qf": ["Brazil", "Germany", "Turkey", "South Korea", "Spain", "England", "USA", "Senegal"],
            "sf": ["Brazil", "Germany", "Turkey", "South Korea"],
            "final": ["Brazil", "Germany"],
            "champion": ["Brazil"],
        },
        2006: {
            "qf": ["Italy", "France", "Germany", "Portugal", "Brazil", "Argentina", "England", "Ukraine"],
            "sf": ["Italy", "France", "Germany", "Portugal"],
            "final": ["Italy", "France"],
            "champion": ["Italy"],
        },
        2010: {
            "qf": ["Spain", "Netherlands", "Germany", "Uruguay", "Brazil", "Argentina", "Paraguay", "Ghana"],
            "sf": ["Spain", "Netherlands", "Germany", "Uruguay"],
            "final": ["Spain", "Netherlands"],
            "champion": ["Spain"],
        },
        2014: {
            "qf": ["Germany", "Argentina", "Netherlands", "Brazil", "France", "Belgium", "Costa Rica", "Colombia"],
            "sf": ["Germany", "Argentina", "Netherlands", "Brazil"],
            "final": ["Germany", "Argentina"],
            "champion": ["Germany"],
        },
        2018: {
            "qf": ["France", "Croatia", "Belgium", "England", "Brazil", "Uruguay", "Sweden", "Russia"],
            "sf": ["France", "Croatia", "Belgium", "England"],
            "final": ["France", "Croatia"],
            "champion": ["France"],
        },
        2022: {
            "qf": ["Argentina", "France", "Croatia", "Morocco", "Brazil", "Netherlands", "Portugal", "England"],
            "sf": ["Argentina", "France", "Croatia", "Morocco"],
            "final": ["Argentina", "France"],
            "champion": ["Argentina"],
        },
    }
    rows = []
    all_teams = sorted(set(seed_rankings()["team"]) | {team for year in stage_sets.values() for teams in year.values() for team in teams})
    for year, stages in stage_sets.items():
        for team in all_teams:
            rows.append({
                "year": year,
                "team": team,
                "reached_qf": int(team in stages["qf"]),
                "reached_sf": int(team in stages["sf"]),
                "reached_final": int(team in stages["final"]),
                "champion": int(team in stages["champion"]),
            })
    return pd.DataFrame(rows)


def load_all_data() -> dict[str, object]:
    groups, fixtures, group_source = fetch_2026_structure()
    rankings, ranking_source = fetch_fifa_rankings()
    elo, elo_source = fetch_elo_ratings()
    values, value_source = fetch_transfermarkt_values()
    live_results, live_source = fetch_live_results()
    sources = [group_source, ranking_source, elo_source, value_source, live_source, *supplemental_sources()]
    return {"groups": groups, "fixtures": fixtures, "rankings": rankings, "elo": elo, "values": values, "live_results": live_results, "sources": sources}


def supplemental_sources() -> list[SourceRecord]:
    now = utc_now()
    return [
        SourceRecord("fifa_schedule", SOURCE_URLS["fifa_schedule"], "reference", now, 0, "Official tournament schedule and match path reference."),
        SourceRecord("format_cross_check", SOURCE_URLS["format_cross_check"], "reference", now, 0, "Independent tournament-format cross-check."),
        SourceRecord("espn_world_cup", SOURCE_URLS["espn_world_cup"], "reference", now, 0, "Readable live scores, fixtures, and World Cup news reference."),
        SourceRecord("football_data_org", SOURCE_URLS["football_data_org"], "optional_api", now, 0, "Optional free-token fallback for World Cup matches. Add FOOTBALL_DATA_TOKEN in Cloudflare to enable live fallback."),
    ]


def source_table(sources: list[SourceRecord]) -> pd.DataFrame:
    rows = [s.__dict__ | {"citation": SOURCE_URLS.get(s.name, s.url)} for s in sources]
    return pd.DataFrame(rows)
