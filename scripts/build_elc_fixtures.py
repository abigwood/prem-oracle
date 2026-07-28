#!/usr/bin/env python3
"""Build the 2026/27 EFL Championship fixture list.

Mirrors scripts/build_fixtures.py, which scrapes the Premier League's own
fixture-release article. The EFL publishes its release as a JS-driven page with
no fixture data in the HTML, so the machine-readable equivalent used here is
ESPN's full fixture rundown, which carries every fixture with its confirmed UK
kick-off time.

Championship rounds fragment across Friday-Monday far more than the Premier
League's do, so rounds are not derived by counting: a round ends the moment a
club would appear in it twice. With a freshly released list, where every club
plays exactly once per round, that reconstructs all 46 rounds exactly.
"""
import html
import html.parser
import json
import re
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCE_URL = "https://www.espn.com/soccer/story/_/id/49173379/efl-championship-fixtures-schedule-2026-27-full"
ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "fixtures-elc.json"

TEAMS = 24
ROUNDS = 46
EXPECTED = TEAMS // 2 * ROUNDS  # 552

# British Summer Time runs to the last Sunday in October and resumes on the
# last Sunday in March, so a season spanning the turn of the year crosses the
# boundary twice.
BST_ENDS = "2026-10-25"
BST_RESUMES = "2027-03-28"

STADIUMS = {
    "Birmingham City": "St Andrew's",
    "Blackburn Rovers": "Ewood Park",
    "Bolton Wanderers": "Toughsheet Community Stadium",
    "Bristol City": "Ashton Gate",
    "Burnley": "Turf Moor",
    "Cardiff City": "Cardiff City Stadium",
    "Charlton Athletic": "The Valley",
    "Derby County": "Pride Park Stadium",
    "Lincoln City": "LNER Stadium",
    "Middlesbrough": "Riverside Stadium",
    "Millwall": "The Den",
    "Norwich City": "Carrow Road",
    "Portsmouth": "Fratton Park",
    "Preston North End": "Deepdale",
    "Queens Park Rangers": "Loftus Road",
    "Sheffield United": "Bramall Lane",
    "Southampton": "St Mary's Stadium",
    "Stoke City": "bet365 Stadium",
    "Swansea City": "Swansea.com Stadium",
    "Watford": "Vicarage Road",
    "West Bromwich Albion": "The Hawthorns",
    "West Ham United": "London Stadium",
    "Wolverhampton Wanderers": "Molineux Stadium",
    "Wrexham": "Racecourse Ground",
}

# The source abbreviates months as "Aug." / "Sep." / "May." — match on the
# first three letters so a change of house style (Sept., September) still parses.
MONTHS = {name: number for number, name in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], start=1)}

DATE_LINE = re.compile(r"^([A-Z][a-z]{2,8})\.? (\d{1,2}), (\d{4})$")
# "Home vs. Away 10 a.m. ET / 3 p.m. UK" — only the UK time is kept.
FIXTURE_LINE = re.compile(
    r"^(?P<home>.+?) vs\. (?P<away>.+?) "
    r"(?:\d{1,2}(?:[.:]\d{2})?\s*(?:a\.m\.|p\.m\.)|noon)\s*ET\s*/\s*"
    r"(?P<uk>\d{1,2}(?:[.:]\d{2})?\s*(?:a\.m\.|p\.m\.)|noon)\s*UK$"
)


class TextParser(html.parser.HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        text = " ".join(data.split())
        if text:
            self.parts.append(text)


def page_lines(cache=None):
    if cache and Path(cache).exists():
        raw = Path(cache).read_text(encoding="utf-8", errors="replace")
    else:
        req = urllib.request.Request(SOURCE_URL, headers={"user-agent": "PremOracleFixtureBuilder/1.0"})
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read().decode("utf-8", "replace")
        if cache:
            Path(cache).write_text(raw, encoding="utf-8")
    parser = TextParser()
    parser.feed(raw)
    return [html.unescape(part) for part in parser.parts]


def parse_uk_time(value):
    """'3 p.m.' / '12.30 p.m.' / 'noon' -> '15:00' / '12:30' / '12:00'."""
    text = value.strip().lower()
    if text == "noon":
        return "12:00"
    match = re.fullmatch(r"(\d{1,2})(?:[.:](\d{2}))?\s*(a\.m\.|p\.m\.)", text)
    if not match:
        return None
    hour, minute, meridiem = match.groups()
    hour = int(hour) % 12
    if meridiem == "p.m.":
        hour += 12
    return f"{hour:02d}:{int(minute or 0):02d}"


def offset_for(date):
    return "+01:00" if date < BST_ENDS or date >= BST_RESUMES else "+00:00"


def slug(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def collect(lines):
    """Every fixture in publication order, each with its calendar date."""
    fixtures = []
    current_date = None
    for line in lines:
        date_match = DATE_LINE.match(line)
        if date_match:
            month, day, year = date_match.groups()
            number = MONTHS.get(month[:3].lower())
            if number:
                current_date = datetime(int(year), number, int(day)).date().isoformat()
            continue
        if not current_date:
            continue
        fixture_match = FIXTURE_LINE.match(line)
        if not fixture_match:
            continue
        time = parse_uk_time(fixture_match.group("uk"))
        if not time:
            continue
        fixtures.append({
            "date": current_date,
            "time": time,
            "home": fixture_match.group("home").strip(),
            "away": fixture_match.group("away").strip(),
        })
    return fixtures


def assign_rounds(fixtures):
    """A round ends as soon as a club would appear in it for a second time."""
    rounds = []
    current = []
    seen = set()
    for fixture in fixtures:
        if fixture["home"] in seen or fixture["away"] in seen:
            rounds.append(current)
            current = []
            seen = set()
        current.append(fixture)
        seen.add(fixture["home"])
        seen.add(fixture["away"])
    if current:
        rounds.append(current)
    return rounds


def build(cache=None):
    fixtures = collect(page_lines(cache))
    if len(fixtures) != EXPECTED:
        raise SystemExit(f"expected {EXPECTED} fixtures, got {len(fixtures)}")

    clubs = sorted({side for fixture in fixtures for side in (fixture["home"], fixture["away"])})
    if len(clubs) != TEAMS:
        raise SystemExit(f"expected {TEAMS} clubs, got {len(clubs)}: {clubs}")
    missing = [club for club in clubs if club not in STADIUMS]
    if missing:
        raise SystemExit(f"no venue mapped for: {missing}")

    rounds = assign_rounds(fixtures)
    if len(rounds) != ROUNDS:
        raise SystemExit(f"expected {ROUNDS} rounds, got {len(rounds)}")
    for number, group in enumerate(rounds, start=1):
        if len(group) != TEAMS // 2:
            raise SystemExit(f"round {number} has {len(group)} fixtures, expected {TEAMS // 2}")

    matches = []
    for number, group in enumerate(rounds, start=1):
        for fixture in group:
            index = len(matches) + 1
            home, away = fixture["home"], fixture["away"]
            matches.append({
                "id": f"elc-2026-27-{index:03d}-{slug(home)}-{slug(away)}",
                "date": fixture["date"],
                "startAt": f"{fixture['date']}T{fixture['time']}:00{offset_for(fixture['date'])}",
                "time": fixture["time"],
                "round": f"Matchweek {number}",
                "matchday": number,
                "tour": "elc",
                "coverage": "all",
                "player1": home,
                "player2": away,
                "homeTeam": home,
                "awayTeam": away,
                "venue": STADIUMS[home],
                "broadcaster": None,
                "status": "upcoming",
                "result": None,
                "source": SOURCE_URL,
            })

    OUT.write_text(json.dumps({
        "status": "live",
        "competition": "EFL Championship",
        "competitionCode": "ELC",
        "season": "2026/27",
        "source": SOURCE_URL,
        "sourcePublished": "2026-06-25",
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "note": "Championship kick-off times are confirmed for August only; later fixtures move for TV.",
        "fixtures": matches,
    }, indent=2) + "\n")
    print(f"wrote {OUT} ({len(matches)} fixtures, {len(rounds)} rounds, {len(clubs)} clubs)")


if __name__ == "__main__":
    import sys
    build(cache=sys.argv[1] if len(sys.argv) > 1 else None)
