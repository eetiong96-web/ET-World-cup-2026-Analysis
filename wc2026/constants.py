from __future__ import annotations

from dataclasses import dataclass


HOSTS = {"Mexico", "Canada", "USA"}

SOURCE_URLS = {
    "fifa_rankings": "https://inside.fifa.com/fifa-world-ranking/men",
    "transfermarkt_values": "https://www.transfermarkt.com/statistik/weltrangliste",
    "elo_ratings": "https://www.eloratings.net/",
    "openfootball_worldcup": "https://github.com/openfootball/worldcup",
    "fifa_schedule": "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/match-schedule",
    "format_cross_check": "https://www.theguardian.com/football/2026/jun/09/a-very-beginners-guide-to-the-world-cup-how-does-it-work-and-the-players-to-look-out-for",
    "espn_scoreboard": "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard",
    "espn_world_cup": "https://www.espn.com/soccer/league/_/name/fifa.world",
}


TEAM_ALIASES = {
    "United States": "USA",
    "United States of America": "USA",
    "Korea Republic": "South Korea",
    "Czech Republic": "Czechia",
    "Türkiye": "Turkey",
    "Turkiye": "Turkey",
    "IR Iran": "Iran",
    "Côte d'Ivoire": "Ivory Coast",
    "Cote d'Ivoire": "Ivory Coast",
    "Congo DR": "DR Congo",
    "Bosnia and Herzegovina": "Bosnia & Herzegovina",
    "Cabo Verde": "Cape Verde",
    "Netherlands": "Netherlands",
}


GROUPS_2026 = {
    "A": ["Mexico", "South Africa", "South Korea", "Czechia"],
    "B": ["Canada", "Bosnia & Herzegovina", "Qatar", "Switzerland"],
    "C": ["Brazil", "Morocco", "Haiti", "Scotland"],
    "D": ["USA", "Paraguay", "Australia", "Turkey"],
    "E": ["Germany", "Curacao", "Ivory Coast", "Ecuador"],
    "F": ["Netherlands", "Japan", "Sweden", "Tunisia"],
    "G": ["Belgium", "Egypt", "Iran", "New Zealand"],
    "H": ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"],
    "I": ["France", "Senegal", "Iraq", "Norway"],
    "J": ["Argentina", "Algeria", "Austria", "Jordan"],
    "K": ["Portugal", "DR Congo", "Uzbekistan", "Colombia"],
    "L": ["England", "Croatia", "Ghana", "Panama"],
}


ROUND_OF_32_SLOTS = [
    ("M73", "2A", "2B"),
    ("M74", "1E", "3A/B/C/D/F"),
    ("M75", "1F", "2C"),
    ("M76", "1C", "2F"),
    ("M77", "1I", "3C/D/F/G/H"),
    ("M78", "2E", "2I"),
    ("M79", "1A", "3C/E/F/H/I"),
    ("M80", "1L", "3E/H/I/J/K"),
    ("M81", "1D", "3B/E/F/I/J"),
    ("M82", "1G", "3A/E/H/I/J"),
    ("M83", "2K", "2L"),
    ("M84", "1H", "2J"),
    ("M85", "1B", "3E/F/G/I/J"),
    ("M86", "1J", "2H"),
    ("M87", "1K", "3D/E/I/J/L"),
    ("M88", "2D", "2G"),
]

KNOCKOUT_NEXT = {
    "R16": [("M89", "W73", "W75"), ("M90", "W74", "W77"), ("M91", "W76", "W78"), ("M92", "W79", "W80"),
            ("M93", "W83", "W84"), ("M94", "W81", "W82"), ("M95", "W86", "W88"), ("M96", "W85", "W87")],
    "QF": [("M97", "W89", "W90"), ("M98", "W93", "W94"), ("M99", "W91", "W92"), ("M100", "W95", "W96")],
    "SF": [("M101", "W97", "W98"), ("M102", "W99", "W100")],
    "Final": [("M104", "W101", "W102")],
}


@dataclass(frozen=True)
class SourceRecord:
    name: str
    url: str
    status: str
    fetched_at: str
    rows: int
    note: str = ""


def normalize_team(name: str) -> str:
    cleaned = " ".join(str(name).replace("\xa0", " ").strip().split())
    return TEAM_ALIASES.get(cleaned, cleaned)
