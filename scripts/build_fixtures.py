#!/usr/bin/env python3
import html
import html.parser
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCE_URL = "https://www.premierleague.com/en/news/4675097/all-380-fixtures-for-202627-premier-league-season"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "fixtures.json"
DEFAULT_TIMES = {
    "Friday": "20:00",
    "Saturday": "15:00",
    "Sunday": "15:00",
    "Monday": "20:00",
    "Tuesday": "20:00",
    "Wednesday": "20:00",
    "Thursday": "20:00",
}
MONTHS = {
    "August": 8, "September": 9, "October": 10, "November": 11, "December": 12,
    "January": 1, "February": 2, "March": 3, "April": 4, "May": 5,
}
STADIUMS = {
    "AFC Bournemouth": "Vitality Stadium",
    "Arsenal": "Emirates Stadium",
    "Aston Villa": "Villa Park",
    "Brentford": "Gtech Community Stadium",
    "Brighton & Hove Albion": "American Express Stadium",
    "Chelsea": "Stamford Bridge",
    "Coventry City": "Coventry Building Society Arena",
    "Crystal Palace": "Selhurst Park",
    "Everton": "Hill Dickinson Stadium",
    "Fulham": "Craven Cottage",
    "Hull City": "MKM Stadium",
    "Ipswich Town": "Portman Road",
    "Leeds United": "Elland Road",
    "Liverpool": "Anfield",
    "Manchester City": "Etihad Stadium",
    "Manchester United": "Old Trafford",
    "Newcastle United": "St. James' Park",
    "Nottingham Forest": "The City Ground",
    "Sunderland": "Stadium of Light",
    "Tottenham Hotspur": "Tottenham Hotspur Stadium",
}


class TextParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        text = " ".join(data.split())
        if text:
            self.parts.append(text)


def page_lines():
    req = urllib.request.Request(SOURCE_URL, headers={"user-agent": "PremOracleFixtureBuilder/1.0"})
    with urllib.request.urlopen(req, timeout=20) as response:
        raw = response.read().decode("utf-8", "replace")
    parser = TextParser()
    parser.feed(raw)
    return [html.unescape(part) for part in parser.parts]


def parse_date(line, current_year):
    match = re.fullmatch(r"(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) (\d{1,2}) ([A-Z][a-z]+)(?: (\d{4}))?", line)
    if not match:
        return None
    weekday, day, month_name, year = match.groups()
    if month_name not in MONTHS:
        return None
    year = int(year) if year else current_year
    if month_name == "January" and current_year == 2026:
        year = 2027
    return weekday, datetime(year, MONTHS[month_name], int(day)).date().isoformat(), year


def parse_match(line, default_time):
    clean = line.strip()
    clean = re.sub(r"\s+\*+$", "", clean)
    broadcaster = None
    bmatch = re.search(r"\s+\(([^)]+)\)\**$", clean)
    if bmatch:
        broadcaster = bmatch.group(1)
        clean = clean[:bmatch.start()].strip()
    time = default_time
    tmatch = re.match(r"(\d{2}:\d{2})\s+(.+)$", clean)
    if tmatch:
        time, clean = tmatch.groups()
    if " v " not in clean:
        return None
    home, away = [part.strip() for part in clean.split(" v ", 1)]
    if not home or not away:
        return None
    return time, home, away, broadcaster


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def build():
    lines = page_lines()
    started = False
    current_date = None
    current_weekday = None
    current_year = 2026
    matches = []
    for line in lines:
        if line == "Friday 21 August 2026":
            started = True
        if not started:
            continue
        if line.startswith("Related Content"):
            break
        parsed_date = parse_date(line, current_year)
        if parsed_date:
            current_weekday, current_date, current_year = parsed_date
            continue
        if not current_date or line.startswith("*"):
            continue
        parsed_match = parse_match(line, DEFAULT_TIMES.get(current_weekday, "15:00"))
        if not parsed_match:
            continue
        time, home, away, broadcaster = parsed_match
        index = len(matches) + 1
        matchday = ((index - 1) // 10) + 1
        kickoff = f"{current_date}T{time}:00+01:00"
        if current_date >= "2026-10-25":
            kickoff = f"{current_date}T{time}:00+00:00"
        matches.append({
            "id": f"pl-2026-27-{index:03d}-{slug(home)}-{slug(away)}",
            "date": current_date,
            "startAt": kickoff,
            "time": time,
            "round": f"Matchday {matchday}",
            "matchday": matchday,
            "tour": "prem",
            "coverage": "all",
            "player1": home,
            "player2": away,
            "homeTeam": home,
            "awayTeam": away,
            "venue": STADIUMS.get(home),
            "broadcaster": broadcaster,
            "status": "upcoming",
            "result": None,
            "source": SOURCE_URL,
        })
    if len(matches) != 380:
        raise SystemExit(f"expected 380 fixtures, got {len(matches)}")
    OUT.write_text(json.dumps({
        "status": "live",
        "competition": "Premier League",
        "season": "2026/27",
        "source": SOURCE_URL,
        "sourcePublished": "2026-06-19",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "note": "Premier League fixtures are subject to change.",
        "fixtures": matches,
    }, indent=2) + "\n")
    print(f"wrote {OUT} ({len(matches)} fixtures)")


if __name__ == "__main__":
    build()
