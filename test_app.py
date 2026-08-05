import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent


class PremOracleTests(unittest.TestCase):
    def test_required_files_exist(self):
        for name in (
            "index.html", "reset-cache.html", "styles.css", "app.js", "manifest.webmanifest", "sw.js",
            "data/fixtures.json", "scripts/build_fixtures.py", "worker/src/worker.js",
        ):
            self.assertTrue((ROOT / name).exists(), name)

    def test_app_shell_is_prem_oracle(self):
        html = (ROOT / "index.html").read_text()
        manifest = (ROOT / "manifest.webmanifest").read_text()
        sw = (ROOT / "sw.js").read_text()
        self.assertIn("Prem Oracle", html)
        self.assertIn("Prem Oracle", manifest)
        # The cache version is asserted as an invariant rather than a literal:
        # what matters at a bump is that all four move together, and a literal
        # here only ever means one more file to edit and one more chance to
        # ship a shell pointing at a stale asset.
        app = (ROOT / "app.js").read_text()
        version = re.search(r'styles\.css\?v=(\d{8}[a-z]?)', html).group(1)
        self.assertIn(f"app.js?v={version}", html)
        self.assertIn(f"prem-oracle-v1-{version}", sw)
        self.assertIn(f'styles.css?v={version}', sw)
        self.assertIn(f'app.js?v={version}', sw)
        self.assertIn(f'const APP_BUILD = "{version}";', app)
        self.assertIn("https://prem-oracle-window.abigwood.workers.dev", html)
        self.assertIn("vendor/capacitor/push-notifications.js", html)
        self.assertIn("vendor/capacitor/share.js", html)
        self.assertIn("vendor/capacitor/share.js", sw)

    def test_fixture_json_has_full_season(self):
        data = json.loads((ROOT / "data/fixtures.json").read_text())
        fixtures = data["fixtures"]
        self.assertEqual(data["competition"], "Premier League")
        self.assertEqual(data["season"], "2026/27")
        self.assertEqual(len(fixtures), 380)
        self.assertEqual(len({fixture["id"] for fixture in fixtures}), 380)
        self.assertEqual({fixture["matchday"] for fixture in fixtures}, set(range(1, 39)))
        for matchday in range(1, 39):
            self.assertEqual(sum(1 for fixture in fixtures if fixture["matchday"] == matchday), 10)
        self.assertTrue(all(fixture.get("venue") for fixture in fixtures))

    def test_opening_and_final_fixtures_seeded(self):
        fixtures = json.loads((ROOT / "data/fixtures.json").read_text())["fixtures"]
        first = fixtures[0]
        last = fixtures[-1]
        self.assertEqual(first["player1"], "Arsenal")
        self.assertEqual(first["player2"], "Coventry City")
        self.assertEqual(first["venue"], "Emirates Stadium")
        self.assertEqual(first["startAt"], "2026-08-21T20:00:00+01:00")
        self.assertEqual(last["player1"], "Sunderland")
        self.assertEqual(last["player2"], "Manchester City")
        self.assertEqual(last["venue"], "Stadium of Light")
        self.assertEqual(last["matchday"], 38)

    def test_score_ui_is_football_specific(self):
        app = (ROOT / "app.js").read_text()
        css = (ROOT / "styles.css").read_text()
        self.assertIn("Predict the scores", app)
        self.assertIn("data-score-window", app)
        self.assertIn("data-score-step", app)
        self.assertIn("data-lock-score", app)
        self.assertIn("calendarHref", app)
        self.assertIn("Your prediction:", app)
        self.assertIn("fixture-calendar", app)
        self.assertIn("match-intel-strip", css)
        self.assertIn("oracle-prob", css)
        self.assertIn("form-guide", css)
        self.assertIn("fixtureDayDiff(match) > 7", app)
        self.assertIn("flash-error", css)
        self.assertIn("setupNativePushNotifications", app)
        self.assertIn("/push-token", app)
        self.assertIn("teamIntel", app)
        self.assertIn("VENUE_OUTLOOK", app)
        self.assertIn(".team-crest", css)
        self.assertIn("TEAM_MARKERS", app)
        self.assertIn('"Arsenal": { bg: "#E20613"', app)
        self.assertIn('"Coventry City": { bg: "#77BBE8"', app)
        self.assertIn(".score-picker", css)
        self.assertIn(".score-step", css)
        self.assertNotIn("COMMON_SCORES", app)
        self.assertNotIn("data-custom-score", app)
        self.assertNotIn("Gentlemen", app)
        self.assertNotIn("Ladies", app)
        self.assertNotIn("set score", app.lower())

    def test_scoring_rules_are_football_tiers(self):
        app = (ROOT / "app.js").read_text()
        logic = (ROOT / "worker/src/logic.js").read_text()
        self.assertIn("Exact score = 5 points", app)
        self.assertIn("Correct draw, wrong score = 2 points", app)
        self.assertIn("Correct winner and goal difference = 2 points", app)
        self.assertIn("Correct winner only = 1 point", app)
        self.assertIn("Match data:", app)
        self.assertIn("football-data.org", app)
        self.assertIn("Football data provided by the Football-Data.org API", app)
        self.assertIn("predictedOutcome === 0 && actualOutcome === 0", logic)
        self.assertIn("pick.p1 - pick.p2 === actual.p1 - actual.p2", logic)
        self.assertIn("pts: 1", logic)

    def test_worker_and_storage_are_separate_from_sw19(self):
        app = (ROOT / "app.js").read_text()
        worker = (ROOT / "worker/src/worker.js").read_text()
        wrangler = (ROOT / "worker/wrangler.toml").read_text()
        self.assertIn("prem_oracle_uid", app)
        self.assertIn("prem-oracle-window", worker)
        self.assertIn('name = "prem-oracle-window"', wrangler)
        self.assertIn('settlement: "manual"', worker)
        self.assertNotIn("wimbledon_oracle", app)
        self.assertNotIn("wimbledon-oracle-window", worker)
        self.assertNotIn("wimbledon.com/graphql", worker)
        self.assertFalse((ROOT / "scripts/sync_official.py").exists())

    def test_fixture_builder_uses_official_premier_league_source(self):
        script = (ROOT / "scripts/build_fixtures.py").read_text()
        self.assertIn("premierleague.com/en/news/4675097", script)
        self.assertIn("expected 380 fixtures", script)
        self.assertNotIn("api_key", script.lower())


class Phase2WiringTests(unittest.TestCase):
    """v1.1 phase 2: real forecast/form, per-league nicknames, universal links."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()
        cls.entitlements = (ROOT / "ios/App/App/App.entitlements").read_text()

    def test_forecast_is_real_data_only(self):
        # No "Illustrative" copy anywhere, and no client-side probability fallback.
        self.assertNotIn("Illustrative", self.app)
        self.assertNotIn("function matchProbabilities", self.app)
        self.assertIn("Forecast unavailable", self.app)
        self.assertIn("hasProbabilities", self.app)

    def test_form_guide_reads_real_team_intel(self):
        self.assertIn("teamIntel", self.app)
        self.assertIn("data.teams", self.app)
        self.assertNotIn("Illustrative form", self.app)

    def test_worker_exposes_teams_block(self):
        self.assertIn("teams: cache.intel.teams", self.worker)

    def test_per_league_nickname_endpoint_and_control(self):
        self.assertIn('path === "/league/nick"', self.worker)
        self.assertIn("updateLeagueNick", self.worker)
        self.assertIn("/league/nick", self.app)
        self.assertIn("Change my name in this league", self.app)
        self.assertIn("data-league-nick", self.app)

    def test_universal_links_wired(self):
        self.assertIn("applinks:abigwood.github.io", self.entitlements)
        self.assertIn("associated-domains", self.entitlements)
        self.assertIn("appUrlOpen", self.app)
        self.assertIn("setupNativeUniversalLinks", self.app)

    def test_official_pl_team_codes(self):
        codes = {
            "Arsenal": "ARS", "Aston Villa": "AVL", "AFC Bournemouth": "BOU",
            "Brentford": "BRE", "Brighton & Hove Albion": "BHA", "Chelsea": "CHE",
            "Coventry City": "COV", "Crystal Palace": "CRY", "Everton": "EVE",
            "Fulham": "FUL", "Hull City": "HUL", "Ipswich Town": "IPS",
            "Leeds United": "LEE", "Liverpool": "LIV", "Manchester City": "MCI",
            "Manchester United": "MUN", "Newcastle United": "NEW",
            "Nottingham Forest": "NFO", "Sunderland": "SUN", "Tottenham Hotspur": "TOT",
        }
        for name, code in codes.items():
            self.assertIn(f'"{name}": "{code}"', self.app)
        # Abbreviations everywhere resolve through teamCode(); the badge no longer
        # renders raw initials (which produced "CC", "HC", "MU").
        self.assertIn("escapeHTML(teamCode(name))", self.app)
        self.assertNotIn("escapeHTML(teamInitials(name))", self.app)


PROMOTED_TEAMS = {"Coventry City", "Hull City", "Ipswich Town"}


class ForecastIntelTests(unittest.TestCase):
    """Validate the forecast intel that build_intel.mjs wires into fixtures.json."""

    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT / "data/fixtures.json").read_text())

    def test_model_metadata_present(self):
        self.assertRegex(self.data["modelVersion"], r"^\d+\.\d+\.\d+$")
        self.assertTrue(self.data.get("generatedAt"))
        self.assertEqual(self.data["forecast"]["version"], self.data["modelVersion"])

    def test_every_fixture_has_sane_probabilities(self):
        for fixture in self.data["fixtures"]:
            probs = fixture.get("probabilities")
            self.assertIsInstance(probs, list, fixture["id"])
            self.assertEqual(len(probs), 3, fixture["id"])
            self.assertTrue(all(isinstance(p, int) for p in probs), fixture["id"])
            self.assertEqual(sum(probs), 100, fixture["id"])
            home, draw, away = probs
            self.assertLessEqual(max(home, away), 75, fixture["id"])  # favourites capped
            self.assertGreaterEqual(draw, 12, fixture["id"])
            self.assertLessEqual(draw, 32, fixture["id"])

    def test_teams_block_covers_all_20_clubs(self):
        teams = self.data["teams"]
        fixture_teams = set()
        for fixture in self.data["fixtures"]:
            fixture_teams.add(fixture["homeTeam"])
            fixture_teams.add(fixture["awayTeam"])
        self.assertEqual(len(teams), 20)
        self.assertEqual(set(teams), fixture_teams)

    def test_team_form_strings_are_six_results(self):
        for name, intel in self.data["teams"].items():
            form = intel["form"]
            self.assertEqual(len(form), 6, name)
            self.assertTrue(all(ch in "WDL" for ch in form), name)

    def test_team_ratings_in_sane_range(self):
        for name, intel in self.data["teams"].items():
            self.assertIsInstance(intel["rating"], int, name)
            self.assertGreaterEqual(intel["rating"], 1320, name)
            self.assertLessEqual(intel["rating"], 1900, name)

    def test_promoted_teams_get_plausible_ratings(self):
        teams = self.data["teams"]
        top_rating = max(t["rating"] for t in teams.values())
        for name in PROMOTED_TEAMS:
            self.assertIn(name, teams)
            rating = teams[name]["rating"]
            # Promoted sides seeded from the Championship with a handicap: a
            # plausible newcomer Elo band, and never the strongest team in the league.
            self.assertGreaterEqual(rating, 1320, name)
            self.assertLessEqual(rating, 1700, name)
            self.assertLess(rating, top_rating, name)
            self.assertIn("Championship", teams[name]["basis"], name)


class NativeShareAndCalendarTests(unittest.TestCase):
    """v1.1.1: the two App Store buttons that silently did nothing on iPhone."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.html = (ROOT / "index.html").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()
        cls.logic = (ROOT / "worker/src/logic.js").read_text()

    def test_share_plugin_is_vendored_and_loaded(self):
        self.assertTrue((ROOT / "vendor/capacitor/share.js").exists())
        self.assertIn('registerPlugin(\'Share\'', (ROOT / "vendor/capacitor/share.js").read_text())
        self.assertIn("vendor/capacitor/share.js", self.html)

    def test_native_share_goes_through_the_capacitor_plugin(self):
        self.assertIn("openShareSheet", self.app)
        self.assertIn("Capacitor?.Plugins?.Share", self.app)
        # The web path still uses navigator.share.
        self.assertIn("await navigator.share(", self.app)

    def test_no_share_call_site_swallows_failures_silently(self):
        # The v1.1 bug: navigator.share(...).catch(() => {}) hid a hard rejection.
        self.assertNotIn("navigator.share({ title: \"Prem Oracle\", text, url }).catch(() => {})", self.app)
        self.assertNotIn("navigator.share({ title: \"Prem Oracle\", text }).catch(() => {})", self.app)
        # Every share now runs through one helper that distinguishes a user
        # dismissing the sheet from the sheet failing to open at all.
        self.assertIn("shareOrWhatsApp", self.app)
        self.assertIn('error?.name === "AbortError"', self.app)

    def test_shared_links_never_use_the_capacitor_scheme_origin(self):
        # location.origin is premoracle://localhost inside the native shell, which
        # is unshareable and makes navigator.share reject with a TypeError.
        self.assertIn("https://abigwood.github.io/prem-oracle/", self.app)
        self.assertIn("inviteLinkFor", self.app)
        self.assertNotIn("${location.origin}${location.pathname}?league=", self.app)

    def test_native_calendar_link_targets_the_worker_ics_endpoint(self):
        self.assertIn("calendarLink", self.app)
        self.assertIn("/ics/", self.app)
        # `download` is a web-only attribute; WKWebView drops it.
        self.assertIn("calendar.download ?", self.app)

    def test_worker_serves_text_calendar(self):
        self.assertIn('path.startsWith("/ics/")', self.worker)
        self.assertIn("fixtureIcs", self.worker)
        self.assertIn('"content-type": "text/calendar; charset=utf-8"', self.worker)
        self.assertIn("buildFixtureIcs", self.logic)
        self.assertIn("parsePickParam", self.logic)


class ClubColourTests(unittest.TestCase):
    """v1.1.1: approved badge colour refinements. TEAM_MARKERS is the single
    source for crests, the forecast strip and anywhere else badges are painted."""

    @classmethod
    def setUpClass(cls):
        app = (ROOT / "app.js").read_text()
        block = app[app.index("const TEAM_MARKERS"):]
        block = block[:block.index("};") + 2]
        cls.markers = {}
        for line in block.splitlines():
            match = re.match(r'\s*"(?P<team>[^"]+)":\s*\{\s*bg:\s*"(?P<bg>#[0-9A-Fa-f]{6})",\s*'
                             r'fg:\s*"(?P<fg>#[0-9A-Fa-f]{6})",\s*border:\s*"(?P<border>#[0-9A-Fa-f]{6})"', line)
            if match:
                cls.markers[match.group("team")] = match.groupdict()

    @staticmethod
    def _luminance(hex_colour):
        def channel(value):
            s = value / 255
            return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4
        r, g, b = (int(hex_colour[i:i + 2], 16) for i in (1, 3, 5))
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

    @classmethod
    def _contrast(cls, a, b):
        la, lb = cls._luminance(a), cls._luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)

    PREMIER_LEAGUE = {
        "Arsenal", "Aston Villa", "AFC Bournemouth", "Brentford", "Brighton & Hove Albion",
        "Chelsea", "Coventry City", "Crystal Palace", "Everton", "Fulham", "Hull City",
        "Ipswich Town", "Leeds United", "Liverpool", "Manchester City", "Manchester United",
        "Newcastle United", "Nottingham Forest", "Sunderland", "Tottenham Hotspur",
    }

    def test_all_twenty_premier_league_clubs_have_markers(self):
        self.assertTrue(self.PREMIER_LEAGUE <= set(self.markers), self.PREMIER_LEAGUE - set(self.markers))

    def test_all_twenty_four_championship_clubs_have_markers(self):
        clubs = {c for f in json.loads((ROOT / "data/fixtures-elc.json").read_text())["fixtures"]
                 for c in (f["player1"], f["player2"])}
        self.assertEqual(len(clubs), 24)
        self.assertTrue(clubs <= set(self.markers), clubs - set(self.markers))
        # The two competitions between them are the whole marker table.
        self.assertEqual(set(self.markers), self.PREMIER_LEAGUE | clubs)

    def test_approved_colour_refinements(self):
        expected = {
            "Arsenal": ("#E20613", "#9C824A"),            # brighter red, gold rim kept
            "Brighton & Hove Albion": ("#0057B8", "#FFCD00"),
            "AFC Bournemouth": ("#DA291C", "#C8A657"),
            "Manchester United": ("#DA291C", "#FBE122"),
            "Nottingham Forest": ("#DD0000", "#D1D5DB"),
            "Everton": ("#003399", "#D1D5DB"),
            "Newcastle United": ("#241F20", "#D1D5DB"),
        }
        for team, (bg, border) in expected.items():
            self.assertEqual(self.markers[team]["bg"], bg, team)
            self.assertEqual(self.markers[team]["border"], border, team)

    def test_untouched_clubs_keep_their_colours(self):
        # Explicitly excluded from the approved subset.
        self.assertEqual(self.markers["Crystal Palace"], {
            "team": "Crystal Palace", "bg": "#1B458F", "fg": "#FFFFFF", "border": "#C4122E"})
        self.assertEqual(self.markers["Sunderland"], {
            "team": "Sunderland", "bg": "#E30613", "fg": "#FFFFFF", "border": "#111111"})

    def test_no_badge_border_is_pure_white_on_a_white_card(self):
        # White rims made the circles vanish against the white match card.
        for team, marker in self.markers.items():
            self.assertNotEqual(marker["border"].upper(), "#FFFFFF", team)

    def test_badge_text_clears_wcag_aa(self):
        for team, marker in self.markers.items():
            ratio = self._contrast(marker["fg"], marker["bg"])
            self.assertGreaterEqual(round(ratio, 2), 4.5, f"{team}: {ratio:.2f}")

    def test_new_arsenal_red_improves_on_the_old_one(self):
        old = self._contrast("#FFFFFF", "#EF0107")
        new = self._contrast("#FFFFFF", self.markers["Arsenal"]["bg"])
        self.assertGreater(new, old)
        self.assertLess(old, 4.5)          # the old red missed AA
        self.assertGreaterEqual(new, 4.5)  # the new one clears it


class MatchweekTerminologyTests(unittest.TestCase):
    """v1.1.1: users see "Matchweek"; code and data field names stay `matchday`."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.logic = (ROOT / "worker/src/logic.js").read_text()
        cls.builder = (ROOT / "scripts/build_fixtures.py").read_text()
        cls.fixtures = json.loads((ROOT / "data/fixtures.json").read_text())["fixtures"]

    def test_no_user_facing_matchday_wording_remains(self):
        # Targets rendered wording only. Identifiers such as selectedMatchday or
        # byMatchday legitimately contain "Matchday" and are checked separately.
        for name, source in (("app.js", self.app), ("worker/src/logic.js", self.logic)):
            for pattern in (r"Matchday \$\{", r"Matchday \d", r"\d+ matchdays",
                            r"Opening matchday", r"Next matchday", r"Loading matchday",
                            r">MD \$\{"):
                self.assertIsNone(re.search(pattern, source), f"{pattern} still in {name}")

    def test_user_facing_strings_say_matchweek(self):
        for snippet in (
            'countPhrase(rounds, "Matchweeks")',
            'class="tour-badge">Matchweek ',
            "Matchweek ${escapeHTML(period)} is open",
            "🏆 ${competition} ${week}",
            "${escapeHTML(label)} \u25be",
            "Share Matchweek ",
            "Loading matchweek",
            '"Choose a matchweek"',
        ):
            self.assertIn(snippet, self.app, snippet)
        self.assertIn("Matchweek ${match.matchday}", self.logic)

    def test_code_identifiers_and_data_fields_are_unchanged(self):
        # The football-data field name stays `matchday` everywhere.
        for identifier in ("selectedMatchday", "matchdayFilter", "currentMatchday",
                           "nextMatchday", "groupedMatchdays", "match.matchday"):
            self.assertIn(identifier, self.app, identifier)
        self.assertTrue(all("matchday" in fixture for fixture in self.fixtures))
        self.assertFalse(any("matchweek" in fixture for fixture in self.fixtures))

    def test_fixture_round_labels_and_builder_agree(self):
        self.assertIn('"round": f"Matchweek {matchday}"', self.builder)
        self.assertNotIn('f"Matchday', self.builder)
        for fixture in self.fixtures:
            self.assertEqual(fixture["round"], f"Matchweek {fixture['matchday']}", fixture["id"])


class KickoffOffsetTests(unittest.TestCase):
    """Kick-off offsets must follow British Summer Time at BOTH boundaries.

    Checking only the October end left the whole April-May run-in stamped an
    hour early, which would have locked picks an hour before kick-off.
    """

    BST_ENDS = "2026-10-25"      # clocks go back
    BST_RESUMES = "2027-03-28"   # clocks go forward

    def offsets(self, path):
        return [(f["date"], f["startAt"][-6:]) for f in json.loads((ROOT / path).read_text())["fixtures"]]

    def assert_bst_correct(self, path):
        for date, offset in self.offsets(path):
            expected = "+01:00" if date < self.BST_ENDS or date >= self.BST_RESUMES else "+00:00"
            self.assertEqual(offset, expected, f"{path} {date}")

    def test_premier_league_offsets_follow_bst(self):
        self.assert_bst_correct("data/fixtures.json")

    def test_championship_offsets_follow_bst(self):
        self.assert_bst_correct("data/fixtures-elc.json")

    def test_bst_resumes_on_28_march_2027(self):
        # The specific regression: the run-in is BST, not GMT.
        runin = [o for d, o in self.offsets("data/fixtures.json") if d >= self.BST_RESUMES]
        self.assertTrue(runin, "expected fixtures after BST resumes")
        self.assertEqual(set(runin), {"+01:00"})
        winter = [o for d, o in self.offsets("data/fixtures.json")
                  if self.BST_ENDS <= d < self.BST_RESUMES]
        self.assertEqual(set(winter), {"+00:00"})

    def test_both_builders_encode_both_boundaries(self):
        for script in ("scripts/build_fixtures.py", "scripts/build_elc_fixtures.py"):
            source = (ROOT / script).read_text()
            self.assertIn(f'BST_ENDS = "{self.BST_ENDS}"', source, script)
            self.assertIn(f'BST_RESUMES = "{self.BST_RESUMES}"', source, script)


class ChampionshipTests(unittest.TestCase):
    """v1.3: the EFL Championship fixture list and its forecast posture."""

    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT / "data/fixtures-elc.json").read_text())
        cls.fixtures = cls.data["fixtures"]

    def test_full_season_of_46_rounds(self):
        self.assertEqual(self.data["competitionCode"], "ELC")
        self.assertEqual(self.data["competition"], "EFL Championship")
        self.assertEqual(len(self.fixtures), 552)
        self.assertEqual(len({f["id"] for f in self.fixtures}), 552)
        self.assertEqual({f["matchday"] for f in self.fixtures}, set(range(1, 47)))
        for round_number in range(1, 47):
            self.assertEqual(sum(1 for f in self.fixtures if f["matchday"] == round_number), 12)

    def test_fixture_ids_are_elc_namespaced(self):
        self.assertTrue(all(f["id"].startswith("elc-2026-27-") for f in self.fixtures))

    def test_every_club_plays_23_home_and_23_away(self):
        clubs = {c for f in self.fixtures for c in (f["player1"], f["player2"])}
        self.assertEqual(len(clubs), 24)
        for club in clubs:
            self.assertEqual(sum(1 for f in self.fixtures if f["player1"] == club), 23, club)
            self.assertEqual(sum(1 for f in self.fixtures if f["player2"] == club), 23, club)
            self.assertTrue(all(f["venue"] for f in self.fixtures if f["player1"] == club), club)

    def test_no_club_appears_twice_in_a_round(self):
        # The round-grouping rule: fragmentation across Fri-Mon must not merge rounds.
        for round_number in range(1, 47):
            group = [f for f in self.fixtures if f["matchday"] == round_number]
            clubs = [c for f in group for c in (f["player1"], f["player2"])]
            self.assertEqual(len(set(clubs)), 24, f"round {round_number}")

    def test_opening_round_spans_the_efl_opening_weekend(self):
        opener = sorted({f["date"] for f in self.fixtures if f["matchday"] == 1})
        self.assertEqual(opener[0], "2026-08-14")
        self.assertLessEqual(opener[-1], "2026-08-17")

    def test_forecasts_are_absent_until_validated(self):
        # Cross-division Elo seeding does not calibrate for this division, so
        # probabilities are withheld and the app shows "Forecast unavailable".
        self.assertTrue(all(f["probabilities"] is None for f in self.fixtures))
        self.assertIsNone(self.data["modelVersion"])
        self.assertIn("awaiting validation", self.data["forecast"]["status"])
        # Form is real data whatever division it came from, so it still ships.
        self.assertEqual(len(self.data["teams"]), 24)
        self.assertTrue(all(re.fullmatch(r"[WDL]{6}", t["form"]) for t in self.data["teams"].values()))

    def test_forecasts_remain_opt_in_in_the_builder(self):
        source = (ROOT / "scripts/build_elc_intel.mjs").read_text()
        self.assertIn('process.argv.includes("--with-forecasts")', source)


class MigrationVocabularyTests(unittest.TestCase):
    """The migration is copy-and-freeze. There is no such stage as the one this
    class scans for, and the term must not survive anywhere a reader could take
    it as one.

    The banned terms are assembled at runtime rather than written out, so this
    file can scan itself without matching its own assertions.
    """

    BANNED = tuple("dual" + sep + "write" for sep in ("-", " ", "_", ""))

    SCANNED = (
        "worker/src", "worker/test", "scripts", "docs",
        "app.js", "test_app.py", "worker/wrangler.toml",
    )
    SUFFIXES = (".js", ".mjs", ".py", ".md", ".toml", ".json")

    @classmethod
    def files(cls):
        for entry in cls.SCANNED:
            target = ROOT / entry
            if target.is_file():
                yield target
            elif target.is_dir():
                for path in sorted(target.rglob("*")):
                    if path.is_file() and path.suffix in cls.SUFFIXES:
                        yield path

    def test_no_bridge_write_language_survives(self):
        offenders = []
        for path in self.files():
            text = path.read_text(errors="replace").lower()
            for term in self.BANNED:
                if term in text:
                    offenders.append(f"{path.relative_to(ROOT)}: {term}")
        self.assertEqual(offenders, [], f"banned migration term remains: {offenders}")

    def test_the_stage_is_named_for_what_it_proves(self):
        migration = (ROOT / "worker/src/migration.js").read_text()
        self.assertIn('"scoped-write-proof"', migration)
        # It is a read-only evidence gate over the write plan.
        self.assertIn('"scoped-write-proof": (env) => stageReadOnlyCheck(env, "scoped-write-proof")', migration)
        runbook = (ROOT / "docs/results-split-runbook.md").read_text()
        self.assertIn("mig run scoped-write-proof true", runbook)

    def test_dual_read_survives_because_it_is_real(self):
        # Reads genuinely do union both keys before the freeze; it was only ever
        # the write side that was never paired.
        self.assertIn('"dual-read"', (ROOT / "worker/src/migration.js").read_text())

    def test_runbook_warns_operators_about_the_fixture_cache(self):
        runbook = (ROOT / "docs/results-split-runbook.md").read_text()
        self.assertIn("60 seconds", runbook)
        self.assertIn("cache-bust", runbook)
        self.assertIn('curl -sS "$API/fixtures?refresh=1" >/dev/null', runbook)
        # The warning belongs before the first stage command, not buried at the end.
        self.assertLess(runbook.index("Operational note"), runbook.index("## Step 0"))


class CompetitionAppTests(unittest.TestCase):
    """v1.3: the app side of the competition foundation."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()
        cls.html = (ROOT / "index.html").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()

    def test_championship_is_gated_by_a_single_flag(self):
        # Live as of v1.3. The gate itself must stay — it is how the Champions
        # League will ship dormant — but the Championship is now on.
        self.assertIn("const FEATURES = { elc: true };", self.app)
        self.assertIn('code === "ELC" && FEATURES.elc', self.app)
        self.assertIn("function availableCompetitions()", self.app.replace("const availableCompetitions = ()", "function availableCompetitions()"))

    def test_competitions_are_checkboxes_not_an_either_or(self):
        # v1.5: the checkboxes moved onto step 2 of the wizard, unchanged in kind.
        self.assertIn("function wizardStepCompetitions()", self.app)
        self.assertIn('name="competitions"', self.app)
        self.assertIn("data-wizard-competition", self.app)
        self.assertIn('role="group"', self.app)
        self.assertNotIn('type="radio" name="competition"', self.app)
        # Scoped to the competition step: the weekly rule IS a one-of-N choice
        # and is legitimately a radiogroup, but competitions never are.
        step = self.app[self.app.index("function wizardStepCompetitions()"):]
        step = step[:step.index("function wizardStepCount()")]
        self.assertNotIn('role="radiogroup"', step)
        self.assertIn('type="checkbox"', step)
        self.assertIn(".competition-choice", self.css)
        # Premier League is still the default, and at least one is required.
        self.assertIn('const DEFAULT_COMPETITION = "PL";', self.app)
        # v1.5: the wizard holds the selection in state rather than in a FormData
        # snapshot, so it survives stepping back and forth.
        self.assertIn("wizard.competitions = competition.checked", self.app)
        self.assertIn('return "Choose at least one competition";', self.app)

    def test_season_length_is_never_hardcoded(self):
        # A mixed league has no single season length — it runs on calendar weeks.
        self.assertIn("const seasonRounds = () => (isMixedActive() ? null : competitionMeta(activeCompetition()).rounds);", self.app)
        self.assertIn("rounds: 38", self.app)
        self.assertIn("rounds: 46", self.app)
        self.assertNotIn("of 38", self.app)

    def test_the_app_loads_every_selected_competition(self):
        # The URL is versioned by the feed's revision now, not the clock, so
        # every layer of cache can actually hold it.
        self.assertIn("const query = [`competition=${code}`];", self.app)
        self.assertIn('query.push(`rev=${encodeURIComponent(revision)}`)', self.app)
        self.assertIn("competitionMeta(code).data", self.app)
        self.assertIn('data: "data/fixtures-elc.json"', self.app)
        # One request per selected competition, merged into one fixture list.
        self.assertIn("competitions.map((code) => loadOneCompetition(code, refresh))", self.app)
        self.assertIn("if (rememberCompetition(leagueState.competitions || leagueState.competition)) await loadFixtures();", self.app)

    def test_mixed_leagues_run_on_their_own_week_window(self):
        self.assertIn("function windowKeyFor(value)", self.app)
        self.assertIn("const periodLabel = (period) =>", self.app)
        self.assertIn("export function windowKeyFor(value)", (ROOT / "worker/src/competitions.js").read_text())
        self.assertIn('const period = String(body.period ?? body.matchweek ?? "").trim();', self.worker)
        # The app sends the period, not a matchweek number.
        self.assertIn('await api("/league/slate", { uid: uid(), code: activeLeague, period, mode, fixtureIds, action: "publish" })', self.app)

    def test_competition_identity_is_visible_in_header_and_shares(self):
        self.assertIn("function leagueCompetitionNames(state)", self.app)
        self.assertIn("🏆 ${competition} ${week}", self.app)
        # A mixed league has no matchweek number, so it shares its window instead.
        self.assertIn("periodLabel(round.period)", self.app)
        # A mixed league names both competitions, not just the first.
        self.assertIn("Prem Oracle ${leagueCompetitionNames(state)} table", self.app)

    def test_matchweek_share_leads_with_the_podium(self):
        self.assertIn("function podiumShareLines(round)", self.app)
        self.assertIn('{ gold: "🏆", silver: "🥈", bronze: "🥉" }', self.app)
        self.assertIn("${podiumShareLines(round)}${rows.join", self.app)

    def test_per_competition_notification_preferences(self):
        self.assertIn('id="notificationPrefs"', self.html)
        self.assertIn("function renderNotificationPrefs()", self.app)
        self.assertIn("data-notif-competition", self.app)
        self.assertIn('await api("/notification-prefs", { uid: uid(), mute: mutedCompetitions });', self.app)
        self.assertIn(".notif-row", self.css)
        # Only worth showing once there is more than one competition.
        self.assertIn("codes.length < 2", self.app)
        # Server side honours it and re-registering a device does not un-mute.
        self.assertIn("const mutes = (record, competition) =>", self.worker)
        self.assertIn("mute: Array.isArray(existing?.mute) ? existing.mute : []", self.worker)

    def test_worker_exposes_competition_endpoints(self):
        for route in ('path === "/notification-prefs"', 'path === "/admin/migration"'):
            self.assertIn(route, self.worker)
        self.assertIn('FIXTURES_URL_ELC', (ROOT / "worker/wrangler.toml").read_text())


class CustomMixTests(unittest.TestCase):
    """v1.2: the host-curated slate, from the creation toggle to the picker."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()
        cls.logic = (ROOT / "worker/src/logic.js").read_text()

    def test_fixture_count_is_one_validation_path(self):
        # v1.5 §9 supersedes the on/off toggle: the count is always on the
        # wizard's third step, 1 to 20, default 6, floor 1.
        self.assertIn("const MIN_FIXTURE_COUNT = 1;", self.app)
        self.assertIn("const MAX_FIXTURE_COUNT = 20;", self.app)
        self.assertIn("const DEFAULT_FIXTURE_COUNT = 6;", self.app)
        self.assertIn('name="fixtureLimit"', self.app)
        self.assertIn("data-count-step", self.app)
        self.assertIn(".count-stepper", self.css)
        # No stale floor of three, and no on/off toggle, survives anywhere.
        self.assertNotIn("MIN_FIXTURE_LIMIT", self.app)
        self.assertNotIn("data-limit-toggle", self.app)
        self.assertNotIn("MIN_FIXTURE_LIMIT", (ROOT / "worker/src/competitions.js").read_text())
        # The same one path on the worker.
        worker_comp = (ROOT / "worker/src/competitions.js").read_text()
        self.assertIn("export const MIN_FIXTURE_COUNT = 1;", worker_comp)
        self.assertIn("export const MAX_FIXTURE_COUNT = 20;", worker_comp)
        self.assertIn("export const DEFAULT_FIXTURE_COUNT = 6;", worker_comp)
        # "All" is a stored intent on the worker too, never inferred.
        self.assertIn("FIXTURE_MODES.includes(requestedMode)", self.worker)

    def test_no_six_to_ten_framing_survives(self):
        for source in (self.app, (ROOT / "index.html").read_text()):
            self.assertNotIn("6–10", source)
            self.assertNotIn("6-10 fixtures", source)
        self.assertNotIn("6-10 fixture selection", (ROOT / "worker/src/worker.js").read_text())
        self.assertIn("Name it, choose your competitions, set how the week works", self.app)

    def test_picker_opens_on_the_default_but_the_week_is_the_hosts(self):
        # The configured count is a rule of thumb, not a cap.
        self.assertIn("Select ${bounds.min}–${bounds.max} · ${count} selected", self.app)
        self.assertIn("const ready = count >= bounds.min && count <= bounds.max;", self.app)
        self.assertIn("take more or fewer this week if you like", self.app)
        self.assertIn("~${rule.count} random fixtures/week", self.app)
        self.assertIn("data-picker-surprise", self.app)
        self.assertIn("Surprise me", self.app)
        self.assertIn("Use all ${list.length} this week", self.app)
        # v1.5: one button, and it publishes.
        self.assertIn("Publish to league", self.app)
        self.assertIn("function pickerBounds(poolSize)", self.app)
        # A short week caps the default rather than blocking, and says so inline.
        self.assertIn("Only ${countPhrase(list.length,", self.app)
        self.assertIn(".picker-note", self.css)

    def test_dice_uses_the_count_the_host_dialled_for_this_week(self):
        handler = self.app[self.app.index("[data-picker-surprise]"):][:520]
        self.assertIn("const dialled = pickerSelection.size || bounds.default;", handler)
        self.assertIn("Math.max(bounds.min, Math.min(dialled, bounds.max))", handler)

    def test_mixed_picker_groups_by_competition_and_chips_the_cards(self):
        self.assertIn("picker-group", self.app)
        self.assertIn(".picker-group", self.css)
        self.assertIn("function competitionChip(match)", self.app)
        self.assertIn(".comp-chip-pl", self.css)
        self.assertIn(".comp-chip-elc", self.css)
        # Chips only where the competition is genuinely ambiguous.
        chip = self.app[self.app.index("function competitionChip(match)"):][:200]
        self.assertIn('if (!isMixedActive()) return "";', chip)

    def test_surprise_me_respects_the_pool_the_count_and_both_competitions(self):
        source = self.app[self.app.index("function surpriseSelection(list, wanted)"):][:1500]
        # One from each represented competition first, then fill at random.
        self.assertIn("for (const [, group] of byCompetition)", source)
        self.assertIn("if (chosen.length >= target) break;", source)
        # Never an error and never a blocked dice when one competition is dark.
        self.assertNotIn("throw", source)
        # Applied as an ordinary selection, so every card stays tappable.
        handler = self.app[self.app.index("[data-picker-surprise]"):][:600]
        self.assertIn("surpriseSelection(pool,", handler)
        self.assertIn('pickerMode = "custom"', handler)

    def test_setting_a_slate_needs_one_confirmation(self):
        # v1.5k: publishing is no longer final — it is final at the first
        # kickoff, and the confirm says so.
        self.assertIn("You can amend the line-up until the first kickoff.", self.app)
        self.assertNotIn("Your league cannot change them after this.", self.app)
        self.assertIn("Publish these ${count} fixtures?", self.app)
        self.assertIn("Update the line-up to ${count}", self.app)
        self.assertIn("data-picker-commit", self.app)
        self.assertIn("picker-confirm-scrim", self.css)
        # Use-all-10 is an explicit full-week record, not a silent absence.
        use_all = self.app[self.app.index('[data-picker-all]'):][:220]
        self.assertIn('pickerMode = "full"', use_all)

    def test_members_get_a_calm_waiting_state_then_fewer_cards(self):
        self.assertIn("Waiting for ${escapeHTML(hostNickname())} to set this week's fixtures", self.app)
        self.assertNotIn("spinner", self.app)
        # v1.5: Next is purely the picks this viewer still owes on the published
        # slate, so the filter is on the slate rather than on today's date.
        self.assertIn("const due = roundFixtures.filter((fixture) => matchOpen(fixture) && !picks[fixture.id]);", self.app)
        self.assertIn("You've picked ${pickedCount} of ${roundFixtures.length}", self.app)

    def test_host_banner_names_the_period(self):
        # A matchweek for a single competition, "Week N · 18–24 Aug" for a mix —
        # the dates earn their place here because you are choosing fixtures.
        self.assertIn("Pick fixtures for ${escapeHTML(periodLabelLong(period))}", self.app)
        self.assertIn("Pick fixtures for ${escapeHTML(periodLabelLong(state.currentPeriod))}", self.app)

    def test_worker_routes_and_storage_key(self):
        for route in ("/league/slate", "/league/custom-mix", "/account/delete"):
            self.assertIn(f'path === "{route}"', self.worker)
        # Slates key on a period: a matchweek number, or a window like w2026-08-10.
        self.assertIn("`custom_slate:${code}:${period}`", self.logic)
        # v1.5k: a published week is amendable until it locks, and frozen after.
        self.assertIn('the first fixture has kicked off — this week\'s line-up is final', self.worker)
        self.assertIn("async function amendSlate(env, league, period,", self.worker)

    def test_fallback_lead_time_is_a_day_not_two_hours(self):
        self.assertIn("const FALLBACK_LEAD_MS = 24 * 60 * 60 * 1000;", self.worker)
        self.assertNotIn("2 * 60 * 60 * 1000", self.worker)


class TrophyTests(unittest.TestCase):
    """v1.2: the weekly podium and the personal Trophy Cabinet."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()
        cls.logic = (ROOT / "worker/src/logic.js").read_text()

    def test_podium_is_points_only_competition_ranking(self):
        self.assertIn('export const PODIUM_PLACES = ["gold", "silver", "bronze"];', self.logic)
        self.assertIn("const rank = rows.filter((other) => other.pts > row.pts).length + 1;", self.logic)
        # Explicit small-league guard rather than assuming a third player exists.
        self.assertIn("const places = Math.min(PODIUM_PLACES.length, memberCount);", self.logic)
        # Zero suppression, matching the existing winner rule.
        self.assertIn("if (!rows.length || rows[0].pts <= 0) return [];", self.logic)

    def test_cabinet_needs_no_new_stored_state(self):
        self.assertIn("export function computeCabinet(", self.logic)
        # The only new KV key in v1.2 is the slate itself.
        new_keys = re.findall(r"kvPut\(env, `([a-z_]+):", (ROOT / "worker/src/worker.js").read_text())
        self.assertNotIn("cabinet", new_keys)
        self.assertNotIn("podium", new_keys)

    def test_cabinet_shelf_and_week_by_week(self):
        self.assertIn("trophy cabinet", self.app)
        self.assertIn("Week by week", self.app)
        self.assertIn('PLACE_EMOJI = { gold: "🏆", silver: "🥈", bronze: "🥉" }', self.app)
        # An empty ring for a week without an award.
        self.assertIn("cab-award-none", self.app)
        self.assertIn(".cab-award-none", self.css)
        # Slate type, fixture count and points on every row.
        self.assertIn('week.slateType === "custom" ? "Custom Mix" : "Full card"', self.app)
        self.assertIn("countPhrase(week.fixtures,", self.app)
        self.assertIn('countPhrase(week.pts, "pts")', self.app)

    def test_winner_banner_extends_to_a_podium(self):
        self.assertIn("function podiumSteps(round)", self.app)
        self.assertIn("${escapeHTML(title)} complete — won by", self.app)
        # The banner header and the share button are unchanged by the restyle.
        self.assertIn("Share Matchweek ", self.app)

    def test_podium_renders_as_a_rostrum_of_steps(self):
        self.assertIn("function podiumStep(place, entries)", self.app)
        self.assertIn('PLACE_NUMBER = { gold: "1", silver: "2", bronze: "3" }', self.app)
        for token in (".podium-steps", ".podium-step-gold", ".podium-step-silver",
                      ".podium-step-bronze", ".podium-block"):
            self.assertIn(token, self.css, token)
        # Winner on the tallest middle step, second to its left, third to its right.
        self.assertIn(".podium-step-gold { order: 2; }", self.css)
        self.assertIn(".podium-step-silver { order: 1; }", self.css)
        self.assertIn(".podium-step-bronze { order: 3; }", self.css)
        self.assertIn(".podium-step-gold .podium-block { height: 52px; background: #F5B800; }", self.css)
        self.assertIn(".podium-step-silver .podium-block { height: 34px; background: #C9CDD4; }", self.css)
        self.assertIn(".podium-step-bronze .podium-block { height: 24px; background: #D9A276; }", self.css)
        self.assertIn("border-radius: 9px 9px 0 0;", self.css)
        # A shared place widens one step rather than inventing a second.
        self.assertIn("podium-step-shared", self.app)
        self.assertIn(".podium-step-shared { min-width: 108px; }", self.css)
        # The old pill strip is gone.
        self.assertNotIn("podium-strip", self.app)
        self.assertNotIn("podium-strip", self.css)
        self.assertNotIn(".podium-place", self.css)

    def test_podium_steps_follow_the_award_rules(self):
        source = self.app[self.app.index("function podiumSteps(round)"):][:700]
        # No podium at all (dead week) still renders nothing.
        self.assertIn("if (!podium.length) return \"\";", source)
        # A place nobody reached has no step, so a two-player league gets two.
        self.assertIn("filter(([, entries]) => entries.length)", source)
        # Steps are emitted gold-first for reading order, placed visually by CSS.
        self.assertIn('["gold", "silver", "bronze"]', source)

    def test_number_and_word_pairs_wrap_as_one_unit(self):
        self.assertIn(".nowrap { white-space: nowrap; }", self.css)
        self.assertIn('function countPhrase(count, word)', self.app)
        for phrase in ('countPhrase(rounds, "Matchweeks")',
                       '<span class="nowrap">Game ${md} of ${seasonRounds()} ·</span>'):
            self.assertIn(phrase, self.app, phrase)
        # The separator rides inside the wrapper, so a line never opens with "·".
        self.assertNotIn("of 38</span> ·", self.app)
        self.assertNotIn("of 38", self.app)


class WeeklyLoopTests(unittest.TestCase):
    """v1.5: the creation wizard, the weekly publish cycle and launch behaviour."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()
        cls.html = (ROOT / "index.html").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()
        cls.logic = (ROOT / "worker/src/logic.js").read_text()
        cls.competitions = (ROOT / "worker/src/competitions.js").read_text()

    # --- 1. the wizard ----------------------------------------------------

    def test_the_league_screen_offers_one_card_and_one_button(self):
        self.assertIn("function createLeagueCard()", self.app)
        self.assertIn(">Get started</button>", self.app)
        self.assertIn("data-wizard-open", self.app)
        self.assertIn("<h3>Join a league</h3>", self.app)
        # "Start a competition" is retired everywhere.
        for source in (self.app, self.html, self.css):
            self.assertNotIn("Start a competition", source)

    def test_the_wizard_is_four_named_steps(self):
        self.assertIn('const WIZARD_STEPS = ["name", "competitions", "count", "share"];', self.app)
        for step in ("wizardStepName", "wizardStepCompetitions", "wizardStepCount", "wizardStepShare"):
            self.assertIn(f"function {step}()", self.app, step)
        self.assertIn("<h3>Name your league</h3>", self.app)
        self.assertIn("<h3>Choose competitions</h3>", self.app)
        self.assertIn("<h3>Fixtures each week</h3>", self.app)
        self.assertIn("<h3>Share your code</h3>", self.app)
        self.assertIn(".wizard-progress", self.css)

    def test_the_competition_step_uses_the_green_selected_state(self):
        # v1.4.1: pale purple -> pale green, the same family as the rule cards.
        self.assertIn(
            ".competition-option input:checked + span { border-color: var(--green); color: var(--green-2); background: #eaf7f1; }",
            self.css)
        self.assertNotIn(".competition-option input:checked + span { border-color: var(--purple)", self.css)
        self.assertIn("competition-option${wizard.competitions.includes(code)", self.app)

    def test_the_green_selected_state_clears_wcag_aa(self):
        def luminance(value):
            channels = [int(value.lstrip("#")[i:i + 2], 16) / 255 for i in (0, 2, 4)]
            channels = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
            return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]

        def contrast(a, b):
            first, second = sorted((luminance(a), luminance(b)), reverse=True)
            return (first + 0.05) / (second + 0.05)

        # Chip label on the selected fill, and the border against the card.
        self.assertGreaterEqual(round(contrast("#064d41", "#eaf7f1"), 2), 4.5)
        self.assertGreaterEqual(round(contrast("#0a7f58", "#ffffff"), 2), 3.0)

    def test_step_three_offers_the_count_and_nothing_else(self):
        # v1.5j: the rule list is gone from the product entirely.
        step = self.app[self.app.index("function wizardStepCount()"):]
        step = step[:step.index("function wizardStepShare()")]
        self.assertIn("data-count-step", step)
        self.assertIn("How many fixtures should your mates predict each week?", step)
        self.assertIn("You can change this — and pick the fixtures yourself — every week.", step)
        self.assertIn('"Create league"}</button>', step)
        # The count control comes first, before anything else on the step.
        self.assertLess(step.index("data-fixture-count"), step.index("wizard-actions"))
        # No rule choice survives anywhere: no markup, no model, no styles.
        for gone in ("data-wizard-rule", "ruleOptions", "wizardOptionSelected",
                     "WEEKLY_RULE_LABEL", "wizard.method", "wizard.scope",
                     "I'll pick each week", "Random weekly", "App picks"):
            self.assertNotIn(gone, self.app, gone)
        for gone in (".rule-option", ".rule-choice"):
            self.assertNotIn(gone, self.css, gone)

    def test_every_new_league_is_manual_first(self):
        rule = self.app[self.app.index("function wizardRule()"):]
        rule = rule[:rule.index("function wizardProgress()")]
        self.assertIn('method: "manual"', rule)
        self.assertIn('wizard.competitions.length > 1 ? "mixed" : wizard.competitions[0]', rule)
        self.assertIn("count: wizard.count", rule)
        # The legacy mirror is always the limited shape now.
        self.assertIn('fixtureMode: "limited",', self.app)
        # The other methods stay valid server-side for leagues that carry one.
        self.assertIn('export const WEEKLY_METHODS = ["manual", "allEligible", "allCompetition", "random"];',
                      self.competitions)

    def test_the_scope_is_explicit_and_never_inferred(self):
        rule = self.app[self.app.index("function wizardRule()"):]
        rule = rule[:rule.index("function wizardProgress()")]
        self.assertIn("competitionScope", rule)
        # And the same shape is still enforced server-side.
        self.assertIn("export function validateWeeklyRule(input, competitions)", self.competitions)
        self.assertIn('return { error: "allCompetition needs a single competition scope" };', self.competitions)
        self.assertIn('"allEligible covers every competition the league plays"', self.competitions)

    def test_the_host_can_edit_the_weekly_count_after_creation(self):
        # The set-and-forget UI is reduced to this: the one setting that is left.
        self.assertIn("function weeklyCountControl(state)", self.app)
        self.assertIn("data-league-count-step", self.app)
        self.assertIn("async function changeWeeklyCount(delta)", self.app)
        self.assertIn(".league-count", self.css)
        saver = self.app[self.app.index("async function changeWeeklyCount(delta)"):]
        saver = saver[:saver.index("// Wizard input is read")]
        # Host-only, clamped to the one validation path, and the stored method
        # and scope ride along untouched.
        self.assertIn("state.owner !== uid()", saver)
        self.assertIn("Math.max(MIN_FIXTURE_COUNT, Math.min(MAX_FIXTURE_COUNT", saver)
        self.assertIn('method: state.weeklyRule?.method || "manual"', saver)
        self.assertIn('await api("/league/weekly-rule"', saver)
        # A failed save puts the old value back rather than lying.
        self.assertIn("leagueState = state;", saver)
        # And a league whose count governs nothing is not offered a stepper.
        control = self.app[self.app.index("function weeklyCountControl(state)"):]
        control = control[:control.index("function leagueView()")]
        self.assertIn('if (method === "allEligible" || method === "allCompetition") return "";', control)

    def test_step_two_copy_says_select(self):
        self.assertIn("Select everything your league should draw fixtures from.", self.app)
        self.assertNotIn("Tick everything your league should draw fixtures from.", self.app)

    def test_a_one_fixture_week_soft_confirms(self):
        self.assertIn("Short week — just one fixture to call!", self.app)
        self.assertIn("data-wizard-confirm-single", self.app)
        self.assertIn(".wizard-confirm", self.css)
        # It is a confirmation, not a block: the count itself is legal.
        self.assertIn("const MIN_FIXTURE_COUNT = 1;", self.app)

    def test_legacy_leagues_normalise_to_manual_with_no_write_back(self):
        rule = self.competitions[self.competitions.index("export function leagueWeeklyRule(league)"):]
        rule = rule[:rule.index("/** True when the rule publishes")]
        self.assertIn('method: "manual"', rule)
        self.assertIn("plan.limit ?? DEFAULT_FIXTURE_COUNT", rule)
        self.assertIn('source: "legacy"', rule)
        # A read never writes: no kvPut, no assignment onto the record.
        self.assertNotIn("kvPut", rule)
        self.assertNotIn("league.weeklyRule =", rule)

    # --- 2. periodKey ------------------------------------------------------

    def test_one_period_key_definition_serves_everything(self):
        self.assertIn("export function periodKeyOf(fixture, mixed)", self.competitions)
        self.assertIn("export const periodKeyForLeague = (league)", self.competitions)
        # The worker's own週 helpers all route through it rather than re-deriving.
        self.assertIn("periodKeyForLeague", self.worker)
        self.assertIn("comparePeriods", self.worker)
        # And the app groups the Schedule on the same abstraction.
        self.assertIn("function groupedPeriods(list, currentPeriod = null)", self.app)
        self.assertIn("const period = periodOfFixture(fixture);", self.app)

    def test_the_window_runs_tuesday_to_monday(self):
        self.assertIn("const WEEKDAY_INDEX = { Tue: 0, Wed: 1, Thu: 2, Fri: 3, Sat: 4, Sun: 5, Mon: 6 };", self.competitions)
        self.assertIn("{ Tue: 0, Wed: 1, Thu: 2, Fri: 3, Sat: 4, Sun: 5, Mon: 6 }", self.app)
        self.assertIn("export function periodOpensAt(period)", self.competitions)
        self.assertIn("export function periodClosesAt(period)", self.competitions)
        # No Monday-anchored language survives in either mirror.
        self.assertNotIn("Monday-anchored", self.competitions)
        self.assertNotIn("Monday-to-Sunday", self.competitions)
        self.assertNotIn("Monday-to-Sunday", self.app)

    # --- 3. draft -> publish ----------------------------------------------

    def test_the_slate_lifecycle_is_one_way(self):
        self.assertIn('export const SLATE_STATUSES = ["draft", "published", "locked", "settled"];', self.logic)
        self.assertIn("export const canAdvanceSlate = (slate, next)", self.logic)
        self.assertIn("STATUS_RANK[next] > STATUS_RANK[slateStatus(slate)]", self.logic)
        self.assertIn('if (!["draft", "publish"].includes(action))', self.worker)

    def test_a_legacy_slate_reads_as_published(self):
        status = self.logic[self.logic.index("export const slateStatus = (slate)"):]
        status = status[:status.index("export const isPublishedSlate")]
        self.assertIn('return SLATE_STATUSES.includes(stored) ? stored : "published";', status)
        # Read boundary only — normaliseSlate returns a copy, it does not mutate.
        self.assertIn("export const normaliseSlate = (slate) => (slate ? { ...slate, status: slateStatus(slate) } : null);", self.logic)

    def test_publish_snapshots_everything_the_spec_names(self):
        snap = self.logic[self.logic.index("export function buildSlateSnapshot"):]
        snap = snap[:snap.index("// Deliberately local")]
        for field in ("periodKey", "ruleSource", "competition", "kickoffAt"):
            self.assertIn(field, snap, field)

    def test_a_reschedule_never_swaps_a_published_fixture(self):
        reconcile = self.logic[self.logic.index("export function reconcileSlate"):]
        reconcile = reconcile[:reconcile.index("export function buildReveals")]
        self.assertIn("if (!isPublishedSlate(slate)", reconcile)
        self.assertIn("added: []", reconcile)
        # The replacement path is gone, not merely unreachable.
        self.assertNotIn("candidates", reconcile)
        self.assertNotIn('reason: "replaced"', reconcile)
        self.assertIn("export function refreshSnapshot(snapshot, roundFixtures)", self.logic)

    def test_the_picker_preload_names_what_it_could_not_carry(self):
        self.assertIn("export function preloadSelection(previousIds, pool)", self.logic)
        for reason in ("notInPool", "voided", "postponed"):
            self.assertIn(f'"{reason}"', self.logic, reason)
        self.assertIn("Dropped from your last selection:", self.app)
        self.assertIn(".picker-note-warn", self.css)

    # --- 4. the weekly loop ------------------------------------------------

    def test_the_host_nudge_copy_splits_on_the_league_shape(self):
        remind = self.worker[self.worker.index("async function remindHost"):]
        remind = remind[:remind.index("/**\n * Resolves what a league")]
        self.assertIn("`Set this week's fixtures for ${league.name}`", remind)
        self.assertIn("`Matchweek ${period} is open — set your fixtures`", remind)
        self.assertIn("isMixedLeague(league)", remind)
        # The same split in the app's own host banner.
        self.assertIn("Set this week's fixtures for ${escapeHTML(leagueState.name)}", self.app)
        self.assertIn("Matchweek ${escapeHTML(period)} is open — set your fixtures", self.app)

    def test_every_weekly_push_is_deduped_on_league_period_and_type(self):
        self.assertIn("async function pushOnce(env, pushType, leagueId, periodKey, uids, body)", self.worker)
        self.assertIn("const key = `notified:${pushType}:${leagueId}:${periodKey}`;", self.worker)
        for push_type in ("slate-open", "slate-published", "auto-published"):
            self.assertIn(f'"{push_type}"', self.worker, push_type)

    def test_publishing_is_idempotent_by_construction(self):
        publish = self.worker[self.worker.index("async function publishSlate"):]
        publish = publish[:publish.index("// POST /league/slate")]
        self.assertIn('if (isPublishedSlate(existing)) return { published: false, reason: "alreadyPublished"', publish)
        self.assertIn('canAdvanceSlate(existing, "published")', publish)
        # A random rule deals the same week twice, seeded on league and period.
        self.assertIn("randomSelection(scoped, rule.count, `${league.code}:${period}`)", self.worker)
        self.assertIn("export function randomSelection(pool, count, seed)", self.logic)
        self.assertNotIn("Math.random", self.logic)

    def test_the_fallback_prefers_a_valid_draft_over_any_rule(self):
        fallback = self.worker[self.worker.index("async function applyFallback"):]
        fallback = fallback[:fallback.index("/**\n * Folds a reschedule into a PUBLISHED slate")]
        self.assertIn('if (isPublishedSlate(stored)) return { published: false, reason: "alreadyPublished" };', fallback)
        self.assertIn("if (isDraftSlate(stored))", fallback)
        self.assertIn("validated.fixtureIds.length", fallback)
        self.assertIn('ruleSource: `auto-published:${selection.ruleSource}`', fallback)
        self.assertIn("const FALLBACK_LEAD_MS = 24 * 60 * 60 * 1000;", self.worker)

    def test_set_and_forget_publishes_with_no_admin_step(self):
        self.assertIn("async function autoPublish(env, league, period, pool, weekNo = null)", self.worker)
        self.assertIn("if (isSetAndForget(rule))", self.worker)
        self.assertIn('path === "/league/weekly-rule"', self.worker)
        self.assertIn("async function setWeeklyRule(env, body)", self.worker)

    # --- 5. tabs and launch ------------------------------------------------

    def test_next_is_purely_the_picks_due_this_week(self):
        self.assertIn("function picksDue()", self.app)
        self.assertIn("Your picks due · ${escapeHTML(periodLabel(period))}", self.app)
        # It no longer shows "today's card" regardless of the league's slate.
        self.assertNotIn("Today's predictions", self.app)

    def test_schedule_opens_on_now_and_collapses_the_future_without_hiding_it(self):
        # Which week starts open is now its own rule, shared by the renderer
        # and the lazy-body decision so they can never disagree.
        rule = self.app[self.app.index("function periodIsOpen(period, current)"):]
        rule = rule[:rule.index("\n}")]
        self.assertIn('String(period) === String(current)', rule)
        self.assertIn("openScheduleDates.has(`md-${period}`)", rule)

        grouped = self.app[self.app.index("function groupedPeriods(list, currentPeriod = null)"):]
        grouped = grouped[:grouped.index("\n}")]
        self.assertIn("<details", grouped)
        self.assertIn("periodIsOpen(period, current)", grouped)
        # Every period is still rendered; only the open attribute and whether
        # its cards exist yet vary.
        self.assertNotIn("filter((period) =>", grouped)
        self.assertIn("dayBody(period, matches, open)", grouped)

    def test_the_launch_decision_tree_has_all_four_branches(self):
        branch = self.app[self.app.index("function launchBranch()"):]
        branch = branch[:branch.index("// True once the viewer has chosen a tab")]
        for name in ("onboarding", "picks", "preseason", "awaiting"):
            self.assertIn(f'"{name}"', branch, name)
        self.assertIn('currentView = launchBranch() === "awaiting" ? "schedule" : "today";', self.app)
        # A cold install re-evaluates once the league and its period are known,
        # and stops the moment the viewer picks a tab themselves.
        self.assertIn("let launchRouted = false;", self.app)
        self.assertIn("if (launchRouted) return;", self.app)
        self.assertIn("launchRouted = true;   // the viewer is driving now", self.app)
        hydrate = self.app[self.app.index("async function hydrateIdentity()"):]
        hydrate = hydrate[:hydrate.index("async function syncUserPicks")]
        self.assertIn("applyLaunchBranch();", hydrate)

    def test_each_launch_branch_carries_the_copy_the_spec_wrote(self):
        self.assertIn("No picks due yet — fixtures will appear here when your host publishes this week's slate.", self.app)
        self.assertIn("Fixtures are loading for the new season. Picks open when your league's weekly slate is published.", self.app)
        self.assertIn(">Create a league</button>", self.app)
        self.assertIn(">Join a league</button>", self.app)
        self.assertIn("function preseasonRow(match)", self.app)
        self.assertIn(".proof-row", self.css)

    # --- 6. v1.4.1 fixes folded into the release -------------------------

    def test_switching_league_paints_from_cache_before_the_network(self):
        switch = self.app[self.app.index("function setActiveLeague(code, refresh = true)"):]
        switch = switch[:switch.index("function saveLeague(code)")]
        # The cached state is applied and rendered on the same tick as the tap;
        # the refresh is what happens afterwards, not what gates the paint.
        self.assertIn("leagueState = activeLeague ? (leagueStates[activeLeague] || null) : null;", switch)
        self.assertIn("render();", switch)
        self.assertLess(switch.index("render();"), switch.index("loadLeagueState()"))

    def test_the_league_cache_is_memory_plus_localstorage(self):
        self.assertIn('leagueStates: "prem_oracle_league_states",', self.app)
        self.assertIn("let leagueStates = readJSON(STORAGE.leagueStates, {});", self.app)
        self.assertIn("function cacheLeagueState(state)", self.app)
        self.assertIn("localStorage.setItem(STORAGE.leagueStates", self.app)
        # A league that has gone must not linger in the cache.
        self.assertIn("function forgetLeagueState(code)", self.app)
        self.assertIn("leagueCodes.includes(code)", self.app)

    def test_other_leagues_are_prefetched_when_the_league_screen_opens(self):
        self.assertIn("async function prefetchLeagueStates()", self.app)
        self.assertIn("leagueCodes.filter((code) => code !== activeLeague)", self.app)
        opener = self.app[self.app.index("async function navigateToView(view)"):]
        opener = opener[:opener.index("// Publishes the slate")]
        self.assertIn("prefetchLeagueStates();", opener)

    def test_the_round_request_does_not_gate_the_season_paint(self):
        loader = self.app[self.app.index("async function loadLeagueState()"):]
        loader = loader[:loader.index("async function loadRoundState()")]
        self.assertIn("cacheLeagueState(state);", loader)
        # The season state is painted before the second /state call goes out.
        self.assertIn("render();\n      await loadRoundState();", loader)

    def test_the_bottom_nav_is_pinned_to_the_safe_area(self):
        nav = self.css[self.css.index(".bottom-nav {"):]
        nav = nav[:nav.index("}")]
        self.assertIn("position: fixed;", nav)
        self.assertNotIn("position: relative;", nav)
        self.assertIn("bottom: 0;", nav)
        self.assertIn("padding-bottom: max(var(--safe-bottom), 6px);", nav)
        # The body cannot scroll, so the keyboard cannot drag the chrome — but it
        # is NOT position:fixed, which would break Full Keyboard Access.
        body = self.css[self.css.index("body {"):]
        body = body[:body.index("}")]
        self.assertIn("overflow: hidden;", body)
        self.assertIn("max-height: 100vh;", body)
        self.assertNotIn("position: fixed;", body)
        # And the scroller reserves the nav's height itself.
        self.assertIn("padding: 18px 0 calc(var(--nav-total-height) + 28px);", self.css)

    def test_the_keyboard_is_dismissed_before_a_re_render(self):
        self.assertIn("function dismissKeyboard()", self.app)
        self.assertIn('if (event.target.matches("[data-join-league], [data-restore]")) dismissKeyboard();', self.app)
        for handler in ("[data-wizard-next]", "[data-wizard-back]", "[data-wizard-cancel]"):
            block = self.app[self.app.index(handler):][:200]
            self.assertIn("dismissKeyboard();", block, handler)

    def test_the_fixture_floor_of_one_is_superseded_everywhere(self):
        # Picker copy, the dice, and the stepper all sit on the same floor.
        self.assertIn("Select ${bounds.min}–${bounds.max}", self.app)
        self.assertIn("const min = Math.min(MIN_FIXTURE_COUNT, poolSize);", self.app)
        self.assertIn("Math.max(MIN_FIXTURE_COUNT, Math.min(MAX_FIXTURE_COUNT, wizard.count + delta))", self.app)
        self.assertIn("const target = Math.max(1, Math.min(wanted || SURPRISE_COUNT, list.length));", self.app)
        # No floor of three, and no 6-10 band, survives in any shipped source.
        for path in ("app.js", "styles.css", "worker/src/worker.js"):
            source = (ROOT / path).read_text()
            self.assertNotIn("MIN_FIXTURE_LIMIT", source, path)
            self.assertNotIn("SLATE_MIN = 6", source, path)
        self.assertIn("export const SLATE_MIN = 1;", (ROOT / "worker/src/logic.js").read_text())
        self.assertIn("export const SLATE_MAX = 20;", (ROOT / "worker/src/logic.js").read_text())

    def test_next_is_never_empty(self):
        today = self.app[self.app.index("function todayView()"):]
        today = today[:today.index("/**\n * Schedule: opens on the current week")]
        # Every path out of the Next tab returns content.
        self.assertIn('if (branch === "onboarding") return', today)
        self.assertIn('if (branch === "preseason") return', today)
        self.assertIn("No picks due yet", today)
        self.assertIn("All done for", today)


class WeekPickerTests(unittest.TestCase):
    """UI polish: the week strip, the season month view, the profile cleanup."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()

    # --- the everyday strip ------------------------------------------------

    def test_the_strip_is_centred_on_the_current_week(self):
        strip = self.app[self.app.index("function weekStrip(selected, attribute)"):]
        strip = strip[:strip.index("function weekSeasonPicker")]
        # The current week is marked so the scroller can find it...
        self.assertIn('data-week-anchor="1"', strip)
        self.assertIn('aria-current="${isCurrent ? "date" : "false"}"', strip)
        # ...and the scroller centres it without dragging the page with it.
        centre = self.app[self.app.index("function centreWeekStrip()"):]
        centre = centre[:centre.index("function render(options = {})")]
        self.assertIn('strip.querySelector("[data-week-anchor]")', centre)
        self.assertIn("strip.scrollLeft += (chipBox.left - stripBox.left) - (strip.clientWidth - chipBox.width) / 2;", centre)
        self.assertNotIn("scrollIntoView", centre)
        self.assertIn("centreWeekStrip();", self.app)

    def test_past_weeks_are_faded_and_the_current_one_is_biggest(self):
        strip = self.app[self.app.index("function weekStrip(selected, attribute)"):]
        strip = strip[:strip.index("function weekSeasonPicker")]
        self.assertIn("const past = comparePeriods(period, current) < 0;", strip)
        self.assertIn('past ? " is-past" : ""', strip)
        self.assertIn(".week-chip.is-past { opacity: .45; }", self.css)
        # Filled green and the largest thing on the strip.
        current = self.css[self.css.index(".week-chip.is-current {"):]
        current = current[:current.index("}")]
        self.assertIn("background: var(--green);", current)
        self.assertIn("transform: scale(1.06);", current)
        self.assertIn(".week-chip.is-current b { color: var(--white); font-size: .95rem; }", self.css)
        self.assertIn("overflow-x: auto;", self.css[self.css.index(".week-strip {"):])

    def test_chips_are_week_n_with_a_date_subtitle(self):
        strip = self.app[self.app.index("function weekStrip(selected, attribute)"):]
        strip = strip[:strip.index("function weekSeasonPicker")]
        # Labelled from the period, so a window reads "Week 11" and a matchweek
        # league "Matchweek 11"; the date subtitle is window-only.
        self.assertIn("<b>${escapeHTML(periodLabel(period))}</b>", strip)
        self.assertIn("escapeHTML(weekDateRange(period))", strip)

    def test_the_tuesday_convention_is_stated_once_not_per_chip(self):
        self.assertIn('const WEEK_CONVENTION = `<p class="week-convention">Weeks run Tuesday to Monday.</p>`;', self.app)
        # No chip anywhere carries a weekday prefix any more.
        for surface in ("function weekStrip(selected, attribute)", "function weekSeasonPicker(selected, attribute)"):
            block = self.app[self.app.index(surface):]
            block = block[:block.index("\n}\n")]
            self.assertNotIn("windowLabel", block, surface)
        # And the old long-label pickers are gone.
        self.assertNotIn("md-picker-wide", self.app)
        self.assertNotIn("md-picker-wide", self.css)
        self.assertNotIn("escapeHTML(windowLabel(value))", self.app)

    def test_weeks_are_numbered_from_the_leagues_first_and_never_called_rounds(self):
        fn = self.app[self.app.index("function weekNumberFor(period)"):]
        fn = fn[:fn.index("const MONTHS_SHORT")]
        self.assertIn("periodsInOrder().indexOf(String(period))", fn)
        self.assertIn("index + 1", fn)
        # "Round" is reserved for official competition rounds.
        for surface in ("function weekStrip(selected, attribute)", "function weekSeasonPicker(selected, attribute)"):
            block = self.app[self.app.index(surface):]
            block = block[:block.index("\n}\n")]
            self.assertNotIn("Round", block, surface)
            self.assertNotIn("round", block.replace("periodsInOrder", ""), surface)

    # --- the season view ---------------------------------------------------

    def test_the_season_view_is_ordered_standings_first(self):
        # Order: season header, trophy cabinet, league table, then the month
        # pills — the table is what people open the Season tab for; the pills
        # are navigation and sit at the bottom.
        line = [l for l in self.app.splitlines() if "inner = `${seasonBanner(state)}" in l][0]
        for earlier, later in (("seasonBanner", "trophyCabinet"),
                               ("trophyCabinet", "seasonTableHtml"),
                               ("seasonTableHtml", "seasonWeeks"),
                               ("seasonWeeks", "leagueRevealsHtml")):
            self.assertLess(line.index(earlier), line.index(later), f"{earlier} must precede {later}")

    def test_week_naming_reaches_every_window_surface(self):
        label = self.app[self.app.index("const periodLabel = (period) =>"):]
        label = label[:label.index("/** Chronological order for periods")]
        # Week N primary for a window, matchweek for a single competition.
        self.assertIn("if (!isWindowKey(period)) return `Matchweek ${period}`;", label)
        self.assertIn("return week == null ? windowLabel(period) : `Week ${week}`;", label)
        # The long form adds the range, for the places where dates help.
        self.assertIn("`Week ${week} \u00b7 ${weekDateRange(period)}`", label)
        # Every named surface now goes through one of the two.
        for surface in (
            "Pick fixtures for ${escapeHTML(periodLabelLong(period))}",
            "Pick fixtures for ${escapeHTML(periodLabelLong(state.currentPeriod))}",
            "${escapeHTML(periodLabelLong(pickerPeriod))}",
            "`Share ${periodLabel(roundState.period)} results`",
            "periodLabel(round.period)",
            "${periodLabel(period)} in progress",
        ):
            self.assertIn(surface, self.app, surface)
        # No surface builds a window name from windowLabel by hand any more.
        for gone in (
            "windowLabel(state.currentPeriod)",
            "windowLabel(round.period)",
            "windowLabel(pickerPeriod)",
        ):
            self.assertNotIn(gone, self.app, gone)

    def test_a_day_card_shows_the_weeks_own_range(self):
        grouped = self.app[self.app.index("function groupedPeriods(list, currentPeriod = null)"):]
        grouped = grouped[:grouped.index("// My Picks still groups by matchweek")]
        self.assertIn("<strong>${escapeHTML(periodLabel(period))}</strong>", grouped)
        # The week's own range, not the first fixture's date, which misleads
        # whenever a week opens on something other than its first day.
        self.assertIn("escapeHTML(weekDateRange(period))", grouped)
        self.assertIn("dateLabel(firstDate, true)", grouped)

    def test_the_convention_is_stated_at_most_once_per_screen(self):
        # Only the two pickers emit it: the const plus one use in each.
        self.assertEqual(self.app.count("WEEK_CONVENTION"), 3)
        # And they never render together — opening the Season tab closes the
        # week picker, so a screen can only ever carry one convention line.
        handler = self.app[self.app.index("const roundTab = event.target.closest"):]
        handler = handler[:handler.index("const roundMd = event.target.closest")]
        self.assertIn("matchdayPickerOpen = false;", handler)

    def test_the_cabinet_never_says_matchweek_null(self):
        # A window league counts its own weeks; it has no matchweek number.
        # This read "Matchweek null" until the cabinet moved up the Season tab.
        row = self.app[self.app.index("function cabinetWeek(week)"):]
        row = row[:row.index("function trophyCabinet(state)")]
        self.assertIn("const weekNumber = weekNumberFor(week.period);", row)
        self.assertIn('`Week ${weekNumber}`', row)
        self.assertNotIn("Matchweek ${week.matchweek}</strong>", row)
        self.assertIn("<strong>${escapeHTML(title)}</strong>", row)

    def test_the_strip_re_anchors_however_it_was_left(self):
        centre = self.app[self.app.index("function centreWeekStrip()"):]
        centre = centre[:centre.index("function render(options = {})")]
        # Measured against the strip, not the page — offsetLeft was the bug.
        self.assertIn("strip.getBoundingClientRect()", centre)
        self.assertIn("anchor.getBoundingClientRect()", centre)
        self.assertNotIn("offsetLeft", centre)
        # A relative adjustment, so any prior scroll is corrected rather than
        # assumed to be zero.
        self.assertIn("strip.scrollLeft +=", centre)
        # An unlaid-out strip waits for a later paint instead of writing junk.
        self.assertIn("if (!anchor || !strip.clientWidth) return;", centre)
        # And it runs on every paint, which is what makes reopening re-anchor.
        self.assertIn("centreWeekStrip();", self.app)

    def test_the_season_view_groups_by_month_without_repeating_labels(self):
        fn = self.app[self.app.index("function weekSeasonPicker(selected, attribute)"):]
        fn = fn[:fn.index("const periodLabel = (period)")]
        # A new section starts only when the month key actually changes, so a
        # month is named once however many weeks it holds.
        self.assertIn("if (!months.length || months[months.length - 1].key !== key) {", fn)
        self.assertIn('<span class="week-month-label">${escapeHTML(month.label)}</span>', fn)
        # Chips are bare day ranges under that label.
        self.assertIn(">${escapeHTML(weekDayRange(period))}</button>", fn)
        # The visible chip is bare; the accessible name still carries the full
        # range, so a screen reader is not left reading "11 to 17" of nothing.
        self.assertIn('aria-label="Week ${weekNumberFor(period)}, ${escapeHTML(weekDateRange(period))}"', fn)
        self.assertIn(".week-month-label", self.css)
        self.assertIn(".week-day-chip", self.css)

    def test_day_ranges_are_bare_and_date_ranges_name_the_month(self):
        bare = self.app[self.app.index("function weekDayRange(period)"):]
        bare = bare[:bare.index("/** The month a week is filed under: the one it opens in. */")]
        self.assertIn("`${start.getUTCDate()}–${end.getUTCDate()}`", bare)
        # A week straddling into the next month names it: "27–2 Nov".
        self.assertIn("`${range} ${MONTHS_SHORT[end.getUTCMonth()]}`", bare)
        self.assertIn("start.getUTCMonth() === end.getUTCMonth()", bare)
        full = self.app[self.app.index("function weekDateRange(period)"):]
        full = full[:full.index("function weekDayRange(period)")]
        # "18–24 Aug" when it stays in a month, both months when it straddles.
        self.assertIn("${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS_SHORT[start.getUTCMonth()]}", full)
        self.assertIn("MONTHS_SHORT[end.getUTCMonth()]", full)

    def test_the_pickers_trigger_names_the_week_the_same_way(self):
        toggle = self.app[self.app.index("function roundToggle()"):]
        toggle = toggle[:toggle.index("function matchdayPicker()")]
        self.assertIn("const week = weekNumberFor(period);", toggle)
        self.assertIn('const label = week == null ? periodLabel(period) : `Week ${week}`;', toggle)
        # A single-competition league still gets "Matchweek 7 ▾".
        self.assertIn("periodLabel(period)", toggle)

    def test_matchweek_leagues_get_the_strip_without_dates_or_convention(self):
        strip = self.app[self.app.index("function weekStrip(selected, attribute)"):]
        strip = strip[:strip.index("/**\n * The season view")]
        # One control, labelled from the period itself.
        self.assertIn("const windows = isWindowKey(periods[0]);", strip)
        self.assertIn("<b>${escapeHTML(periodLabel(period))}</b>", strip)
        # Dates and the convention line are window-only.
        self.assertIn("${windows ? WEEK_CONVENTION : \"\"}", strip)
        self.assertIn("${windows ? `<em>${escapeHTML(weekDateRange(period))}</em>` : \"\"}", strip)
        self.assertIn("week-strip-plain", strip)
        self.assertIn(".week-strip-plain .week-chip { min-width: 0;", self.css)
        # The picker is the strip for every league; the old grid is retired.
        picker = self.app[self.app.index("function matchdayPicker()"):]
        picker = picker[:picker.index("function fixtureHasResult")]
        self.assertIn('return weekStrip(current, "data-round-md");', picker)
        for gone in ("md-picker", "md-cell"):
            self.assertNotIn(gone, self.app, gone)
            self.assertNotIn(gone, self.css, gone)

    # --- the profile -------------------------------------------------------

    def test_the_total_and_to_pick_boxes_are_gone(self):
        picks = self.app[self.app.index("function picksView()"):]
        picks = picks[:picks.index("function leagueSwitcher")]
        # The count now reflects VISIBLE picks, since a dropped fixture's pick
        # is filtered from the view (never deleted).
        self.assertIn("<b>${visible.length}</b><span>Picks made</span>", picks)
        # Removed outright, with nothing put in their place.
        self.assertNotIn("Total fixtures", self.app)
        self.assertNotIn("To pick", self.app)
        self.assertNotIn("fixtures.length - picked.length", self.app)
        self.assertEqual(picks.count('class="stat"'), 1)
        # The lone box does not stretch across the old three columns.
        self.assertIn("stats-grid-single", picks)
        self.assertIn(".stats-grid-single { grid-template-columns: minmax(0, 200px); }", self.css)


class AmendBeforeKickoffTests(unittest.TestCase):
    """v1.5k: versioned publish, the amend flow, and the nickname fix."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()
        cls.logic = (ROOT / "worker/src/logic.js").read_text()

    # --- the amend affordance -------------------------------------------

    def test_a_published_line_up_offers_edit_and_shows_the_lock_moment(self):
        notice = self.app[self.app.index("function slateNotice(period)"):]
        notice = notice[:notice.index("function slateSummary(slate)")]
        # Host only, and only while it is still amendable.
        self.assertIn("const canEdit = isLeagueHost() && !published.locked;", notice)
        self.assertIn(">Edit line-up</button>", notice)
        self.assertIn("data-amend=", notice)
        # Both sides see the deadline: lockLine is rendered for everyone,
        # the button only for the host.
        self.assertIn("${lockLine(published)}", notice)

    def test_the_lock_moment_is_a_concrete_time(self):
        fn = self.app[self.app.index("function lockTimeLabel(slate)"):]
        fn = fn[:fn.index("function lockLine(slate)")]
        self.assertIn("slate?.lockAt", fn)
        self.assertIn('timeZone: "Europe/London"', fn)
        self.assertIn('weekday: "short"', fn)
        line = self.app[self.app.index("function lockLine(slate)"):]
        line = line[:line.index("function slateNotice(period)")]
        self.assertIn("Locks ${escapeHTML(when)}", line)
        self.assertIn("Line-up locked — the first fixture has kicked off.", line)
        self.assertIn(".lock-line", self.css)

    def test_the_picker_knows_it_is_amending(self):
        self.assertIn("let pickerAmending = false;", self.app)
        self.assertIn("function openFixturePicker(period, amending = false)", self.app)
        self.assertIn('openFixturePicker(open.dataset.openPicker, open.hasAttribute("data-amend"))', self.app)
        self.assertIn('<h2>${pickerAmending ? "Edit line-up" : "Pick your fixtures"}</h2>', self.app)
        self.assertIn('${pickerAmending ? "Update line-up" : "Publish to league"}', self.app)
        # Abandoning an amendment must not overwrite the published line-up
        # with a draft.
        saver = self.app[self.app.index("async function saveSlateDraft()"):]
        saver = saver[:saver.index("async function handleWizardClick")]
        self.assertIn("if (pickerAmending) return;", saver)

    def test_the_confirm_says_amendable_until_kickoff(self):
        self.assertIn("You can amend the line-up until the first kickoff.", self.app)
        self.assertNotIn("Your league cannot change them after this.", self.app)

    # --- the version chain ------------------------------------------------

    def test_publishing_appends_and_never_rewrites(self):
        fn = self.logic[self.logic.index("export function appendSlateVersion(slate,"):]
        fn = fn[:fn.index("/**\n * When the latest published version locks")]
        # A new object, with the existing chain carried across untouched.
        self.assertIn("const chain = slateVersions(slate);", fn)
        self.assertIn("versions: [...chain, entry],", fn)
        self.assertIn("const version = previous.version + 1;", fn)
        # The latest values are mirrored up so existing readers resolve to them.
        self.assertIn("fixtureIds,", fn)
        # Nothing in here mutates a prior entry.
        for mutation in ("chain[", "previous.fixtureIds =", ".push(", ".splice("):
            if mutation == "chain[":
                continue
            self.assertNotIn(mutation, fn, mutation)

    def test_a_slate_without_a_version_is_version_one(self):
        self.assertIn("export const slateVersion = (slate) =>", self.logic)
        self.assertIn("export function slateVersions(slate)", self.logic)
        chain = self.logic[self.logic.index("export function slateVersions(slate)"):]
        chain = chain[:chain.index("/** What an amendment did")]
        self.assertIn("if (Array.isArray(slate.versions) && slate.versions.length) return slate.versions;", chain)
        self.assertIn("version: 1,", chain)

    def test_the_lock_is_the_earliest_kickoff_with_no_grace(self):
        fn = self.logic[self.logic.index("export function slateLockAt(slate, pool = null)"):]
        fn = fn[:fn.index("/** Has the latest published version locked?")]
        # The earliest kickoff among the LATEST version's fixtures, live pool
        # first and the snapshot as fallback.
        self.assertIn("Math.min(...times)", fn)
        self.assertIn("slate?.snapshot?.fixtures", fn)
        locked = self.logic[self.logic.index("export function slateIsLocked(slate, nowMs, pool = null)"):]
        locked = locked[:locked.index("// ---")] if "// ---" in locked else locked[:400]
        # >= , not > : the kickoff itself freezes it. No grace window.
        self.assertIn("nowMs >= at", locked)

    def test_amendment_is_refused_after_lock_with_no_override(self):
        fn = self.worker[self.worker.index("async function amendSlate(env, league, period,"):]
        fn = fn[:fn.index("/** \"2 fixtures added, 1 removed\"")]
        self.assertIn('return { amended: false, reason: "locked", lockAt, slate: normaliseSlate(existing) };', fn)
        # No force/override parameter exists on this path at all.
        for override in ("force", "override", "ignoreLock"):
            self.assertNotIn(override, fn, override)
        self.assertIn("the first fixture has kicked off — this week\u2019s line-up is final".replace("\u2019", "'"), self.worker)

    def test_an_amendment_notifies_once_per_version(self):
        fn = self.worker[self.worker.index("async function amendSlate(env, league, period,"):]
        fn = fn[:fn.index("/** \"2 fixtures added, 1 removed\"")]
        self.assertIn("`amend-v${next.version}`", fn)
        self.assertIn('title: "Line-up updated"', fn)
        self.assertIn("update your picks before kick-off.", fn)
        # Pushes can carry a title now, not just a body.
        self.assertIn('const alert = typeof message === "string" ? message : { title: message.title, body: message.body };', self.worker)

    def test_the_fallback_still_never_touches_a_published_week(self):
        fn = self.worker[self.worker.index("async function applyFallback(env, league, period, roundFixtures"):]
        fn = fn[:fn.index("/**\n * Folds a reschedule into a PUBLISHED slate")]
        self.assertIn('if (isPublishedSlate(stored)) return { published: false, reason: "alreadyPublished" };', fn)
        self.assertNotIn("amendSlate", fn, "the safety net never amends a line-up somebody chose")

    # --- the nickname fix -------------------------------------------------

    def test_a_rename_writes_through_the_cache_and_repaints(self):
        self.assertIn("function applyNickLocally(code, memberUid, nick)", self.app)
        fn = self.app[self.app.index("function applyNickLocally(code, memberUid, nick)"):]
        fn = fn[:fn.index("/**\n * Warms the cache")]
        # The live state, the round table and the cached copy all follow.
        self.assertIn("cacheLeagueState(leagueState);", fn)
        self.assertIn("roundState = { ...roundState, table: rename(roundState.table)", fn)
        self.assertIn("leagueStates = { ...leagueStates, [code]:", fn)
        # And the rename repaints before waiting on the server. That now lives
        # in the nick dialog's submit handler rather than the click branch,
        # because prompt() was replaced with a real field.
        handler = self.app[self.app.index('document.getElementById("nickForm").addEventListener'):]
        handler = handler[:handler.index('document.getElementById("nickDialog").addEventListener')]
        self.assertIn("applyNickLocally(code, uid(), result.nick);", handler)
        self.assertLess(handler.index("applyNickLocally"), handler.index("await loadLeagueState()"))
        self.assertLess(handler.index("render();"), handler.index("await loadLeagueState()"))


class MyPredictionsTests(unittest.TestCase):
    """Clean removal of dropped picks, and the league-sectioned layout."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()

    # --- A. clean removal ------------------------------------------------

    def test_a_pick_is_hidden_not_deleted(self):
        fn = self.app[self.app.index("function hiddenPickIds(contexts"):]
        fn = fn[:fn.index("/** A fixture by id")]
        # Hidden = dropped somewhere AND asked for by nobody.
        self.assertIn("if (!contexts.length) return hidden;", fn)
        self.assertIn("if (!stillAsked.has(id)) hidden.add(id);", fn)
        # Nothing in the whole view deletes a pick.
        view = self.app[self.app.index("// --- My Predictions ---"):]
        view = view[:view.index("function leagueSwitcher")]
        for destructive in ("delete picks[", "picks = {}", "removeItem(STORAGE.picks"):
            self.assertNotIn(destructive, view, destructive)

    def test_the_count_reflects_visible_picks(self):
        view = self.app[self.app.index("function picksView()"):]
        view = view[:view.index("function leagueSwitcher")]
        self.assertIn("<b>${visible.length}</b><span>Picks made</span>", view)
        self.assertIn("const visible = visiblePickedFixtures(hidden);", view)

    def test_the_dropped_set_comes_from_the_version_deltas(self):
        # The app cannot derive 'dropped' from a slate's latest state; the
        # worker walks the version chain and hands both sets over.
        self.assertIn("for (const entry of slateVersions(slate)) {", self.worker)
        self.assertIn("for (const id of entry.changed?.removed || []) droppedFixtureIds.add(String(id));", self.worker)
        # A fixture put back is not dropped.
        self.assertIn("const dropped = [...droppedFixtureIds].filter((id) => !lineup.includes(id));", self.worker)
        self.assertIn("lineupFixtureIds: lineup,", self.worker)
        self.assertIn("droppedFixtureIds: dropped,", self.worker)

    # --- B. the sectioned layout ------------------------------------------

    def test_one_section_per_league_then_the_rest(self):
        view = self.app[self.app.index("function picksView()"):]
        view = view[:view.index("function leagueSwitcher")]
        # A section per league, over that league's own line-up.
        self.assertIn("const mine = visible.filter((fixture) => league.lineup.has(String(fixture.id)));", view)
        self.assertIn("pickWeekGroups(mine, mixed)", view)
        # Then everything not claimed by a league.
        self.assertIn("const others = visible.filter((fixture) => !claimed.has(String(fixture.id)));", view)
        self.assertIn('pickSection("Your other predictions"', view)
        # A league-less viewer keeps the plain list.
        self.assertIn("if (!contexts.length) {", view)
        self.assertIn("groupedMatchdays(visible)", view)

    def test_sections_are_week_grouped_by_that_leagues_own_shape(self):
        fn = self.app[self.app.index("function pickWeekGroups(list, mixed)"):]
        fn = fn[:fn.index("function pickEntry(fixture, note)")]
        self.assertIn("mixed", fn)
        self.assertIn("windowKeyFor(fixture.startAt)", fn)
        self.assertIn("`Matchweek ${period}`", fn)
        # Labelled by date range, not week number: the number belongs to the
        # active league's ordering, which is not this league's.
        self.assertIn("weekDateRange(period)", fn)
        self.assertIn(".pick-week-label", self.css)

    def test_a_shared_fixture_says_so_in_both_sections(self):
        fn = self.app[self.app.index("function sharedLeagueNote(fixtureId, contexts, thisCode)"):]
        fn = fn[:fn.index("function picksView()")] if "function picksView()" in fn else fn[:900]
        self.assertIn("league.code !== thisCode && league.lineup.has(String(fixtureId))", fn)
        self.assertIn("Also in ${escapeHTML(others.join(\", \"))}", fn)
        self.assertIn("one pick counts in both", fn)
        self.assertIn(".pick-shared", self.css)

    def test_one_pick_per_fixture_is_still_the_model(self):
        # Sections render the same matchCard, which reads and writes the one
        # picks[matchId] entry — so editing in either section is one edit.
        self.assertIn("return `<div class=\"pick-entry\">${matchCard(fixture)}${note}</div>`;", self.app)
        saver = self.app[self.app.index("async function savePick(matchId, p1, p2)"):]
        saver = saver[:saver.index("document.addEventListener(\"submit\"")]
        self.assertIn("picks[matchId] = { p1, p2, savedAt: Date.now() };", saver)

    def test_league_sections_collapse_and_remember(self):
        fn = self.app[self.app.index("function pickSection(title, subtitle, groups, contexts, code)"):]
        fn = fn[:fn.index("function picksView()")]
        # A native details/summary, so the chevron and keyboard both work.
        self.assertIn('<details class="pick-section" data-pick-section=', fn)
        self.assertIn("<summary class=\"pick-section-head\">", fn)
        # Default expanded: only the collapsed ones are remembered.
        self.assertIn("const open = !collapsedPickSections.has(key);", fn)
        self.assertIn("${open ? \" open\" : \"\"}", fn)
        self.assertIn("let collapsedPickSections = new Set(readJSON(STORAGE.pickSections, []));", self.app)
        self.assertIn('pickSections: "prem_oracle_pick_sections",', self.app)
        # The other-predictions section collapses on the same mechanism.
        self.assertIn('const key = code || "__other";', fn)

    def test_a_collapsed_header_still_shows_its_pick_count(self):
        fn = self.app[self.app.index("function pickSection(title, subtitle, groups, contexts, code)"):]
        fn = fn[:fn.index("function picksView()")]
        # Counted from the section's own groups, and rendered in the header
        # rather than the body, so collapsing cannot hide it.
        self.assertIn("const count = groups.reduce((total, group) => total + group.matches.length, 0);", fn)
        self.assertIn('<span class="pick-section-count">${countPhrase(count, count === 1 ? "pick" : "picks")}</span>', fn)
        header_end = fn.index('</summary>')
        self.assertLess(fn.index('pick-section-count'), header_end, 'the count must be inside the summary')
        self.assertIn(".pick-section-count", self.css)

    def test_toggling_a_section_persists_it(self):
        handler = self.app[self.app.index('document.addEventListener("toggle"'):]
        handler = handler[:handler.index("// --- Per-competition notification preferences")]
        self.assertIn('const section = event.target.closest?.("[data-pick-section]");', handler)
        self.assertIn("if (section.open) collapsedPickSections.delete(key);", handler)
        self.assertIn("else collapsedPickSections.add(key);", handler)
        self.assertIn("localStorage.setItem(STORAGE.pickSections, JSON.stringify([...collapsedPickSections]));", handler)
        # The schedule day-cards keep their own separate memory.
        self.assertIn("openScheduleDates.add(card.dataset.dayCard);", handler)
        self.assertLess(handler.index("data-pick-section"), handler.index("data-day-card"))

    def test_the_chevron_turns_with_the_section(self):
        self.assertIn('.pick-section-head::after', self.css)
        self.assertIn('content: "⌄";', self.css)
        self.assertIn(".pick-section[open] > .pick-section-head::after { transform: rotate(180deg); }", self.css)
        # The default marker is suppressed so only our chevron shows.
        self.assertIn(".pick-section-head::-webkit-details-marker { display: none; }", self.css)
        self.assertIn("list-style: none;", self.css[self.css.index(".pick-section-head {"):])

    def test_my_picks_loads_every_leagues_state_and_fixtures(self):
        nav = self.app[self.app.index("async function navigateToView(view)"):]
        nav = nav[:nav.index("// Publishes the slate")]
        self.assertIn('if (currentView === "picks") {', nav)
        self.assertIn("await prefetchLeagueStates();", nav)
        self.assertIn("await loadFixturesForLeagues();", nav)
        # The side map never disturbs the active league's fixture list.
        loader = self.app[self.app.index("async function loadFixturesForLeagues()"):]
        loader = loader[:loader.index("function rememberCompetition(codes)")]
        self.assertIn("extraFixtures = next;", loader)
        self.assertNotIn("fixtures =", loader)


class LeagueSwitchAndShareTests(unittest.TestCase):
    """Build 10 field reports: crossed-over nicknames, and a slow share sheet."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()

    # --- the stale-response guard ----------------------------------------

    def test_a_league_fetch_takes_a_ticket(self):
        self.assertIn("let leagueStateRequest = 0;", self.app)
        fn = self.app[self.app.index("async function loadLeagueState()"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn("const ticket = ++leagueStateRequest;", fn)
        self.assertIn("const requested = activeLeague;", fn)
        self.assertIn("ticket !== leagueStateRequest || requested !== activeLeague", fn)
        # The request names the league it asked for, not whichever is active by
        # the time the line runs.
        self.assertIn("fetchState(seasonStatePath(requested))", fn)
        self.assertIn("const seasonStatePath = (code) =>", self.app)
        self.assertNotIn("/state?code=${encodeURIComponent(activeLeague)}", fn)

    def test_a_superseded_answer_is_cached_but_not_painted(self):
        fn = self.app[self.app.index("async function loadLeagueState()"):]
        fn = fn[:fn.index("\n}")]
        # It is still true about its own league, so the cache keeps it...
        self.assertLess(fn.index("cacheLeagueState(state);"), fn.index("if (superseded()) return;"))
        # ...but only the newest may become the state on screen.
        self.assertLess(fn.index("if (superseded()) return;"), fn.index("leagueState = state;"))
        # Errors are gated the same way: a dead league must not blank a live one.
        self.assertIn("forgetLeagueState(requested);", fn)
        self.assertIn("removeStoredLeague(requested);", fn)
        self.assertEqual(fn.count("if (superseded()) return;"), 3)

    def test_the_round_table_guards_on_its_period_too(self):
        fn = self.app[self.app.index("async function loadRoundState()"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn("const ticket = ++roundStateRequest;", fn)
        self.assertIn("const period = selectedPeriod;", fn)
        self.assertIn("String(period) !== String(selectedPeriod)", fn)
        self.assertIn("requested !== activeLeague", fn)

    def test_a_rename_only_touches_its_own_league(self):
        fn = self.app[self.app.index("function applyNickLocally(code, memberUid, nick)"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn("leagueState.code === code", fn)
        self.assertIn("roundState.code === code", fn)
        # Every rename in here is scoped; none reaches an unnamed table.
        self.assertNotIn("if (roundState && !roundState.error) {", fn)

    def test_the_rename_banner_does_not_outlive_its_league(self):
        fn = self.app[self.app.index("function setActiveLeague(code, refresh = true)"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn("const next = code || \"\";", fn)
        self.assertIn("if (next !== activeLeague) clearFlash();", fn)
        # The banner names no league, so it can only be read as the one on screen.
        self.assertIn("setFlash(`Now showing as ${result.nick} in this league`);", self.app)

    # --- repaints and taps -------------------------------------------------

    def test_a_repaint_that_changes_nothing_is_not_made(self):
        fn = self.app[self.app.index("function render(options = {})"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn("const changed = html !== renderedHTML;", fn)
        self.assertIn("if (changed) {", fn)
        self.assertIn("app.innerHTML = html;", fn)
        self.assertIn("renderedHTML = html;", fn)
        # A strip nobody rebuilt is not re-centred under a viewer scrolling it.
        self.assertIn("if (changed) centreWeekStrip();", fn)

    def test_a_repaint_is_held_for_the_length_of_a_tap(self):
        fn = self.app[self.app.index("function render(options = {})"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn("if (tapInProgress) { heldRender = options; return; }", fn)
        flush = self.app[self.app.index("function flushHeldRender()"):]
        flush = flush[:flush.index("\n}")]
        self.assertIn("tapInProgress = false;", flush)
        self.assertIn("if (held) render(held);", flush)

    def test_every_way_a_tap_can_end_releases_the_repaint(self):
        for release in (
            'document.addEventListener("pointercancel", flushHeldRender, true);',
            'document.addEventListener("pointerup", () => setTimeout(flushHeldRender, 0), true);',
            'document.addEventListener("click", flushHeldRender);',
        ):
            self.assertIn(release, self.app, release)
        # And a finger simply held down cannot freeze the screen.
        self.assertIn("setTimeout(flushHeldRender, 500);", self.app)
        # The click flush is registered after the handler that acts on the tap,
        # so the button is never replaced before its own click is delivered.
        self.assertLess(
            self.app.index('document.addEventListener("click", async (event) => {'),
            self.app.index('document.addEventListener("click", flushHeldRender);'),
        )

    # --- the share gesture -------------------------------------------------

    def test_the_share_call_is_synchronous(self):
        fn = self.app[self.app.index("function shareNow({ title, text, url })"):]
        fn = fn[:fn.index("\n}")]
        self.assertNotIn("await", fn, "an await here would end the tap")
        self.assertNotIn("async", fn)
        self.assertIn("opening = plugin.share({ title, text, url, dialogTitle: title });", fn)
        # The waiting happens after, on the promise the tap already started.
        self.assertIn("opening.catch((error) => {", fn)
        self.assertIn('if (error?.name === "AbortError"', fn)

    def test_the_invite_text_is_prepared_not_fetched(self):
        fn = self.app[self.app.index("function leagueInvite(code)"):]
        fn = fn[:fn.index("\n}")]
        self.assertNotIn("await", fn)
        self.assertIn("const url = inviteLinkFor(code);", fn)
        self.assertIn("Join my Prem Oracle league ${code}", fn)

    def test_share_branches_sit_above_every_await(self):
        handler = self.app[self.app.index('document.addEventListener("click", async (event) => {'):]
        head = handler[:handler.index('const leagueCountStep = event.target.closest')]
        code = re.sub(r"//[^\n]*", "", head)
        self.assertNotIn("await", code, "the share sheet must be raised inside the tap")
        self.assertIn('event.target.closest("[data-share-league]")', code)
        self.assertIn("shareNow(leagueInvite(share.dataset.shareLeague));", code)
        self.assertIn('event.target.closest("[data-export-league-table]") && shareTableNow()', code)

    def test_the_drawn_share_card_is_the_only_path_that_waits(self):
        fn = self.app[self.app.index("function shareTableNow()"):]
        fn = fn[:fn.index("\n}")]
        self.assertNotIn("await", fn)
        self.assertIn("shareNow({ title: \"Prem Oracle\", text: roundShareText(leagueState, roundState) });", fn)
        self.assertIn("isNativeApp() && leagueState?.table?.length", fn)
        # The remaining branch below is the PNG card, which must be built first.
        later = self.app[self.app.index('const exportTable = event.target.closest("[data-export-league-table]");'):]
        later = later[:later.index("const scoreWindow")]
        self.assertIn("await shareLeagueTableGraphic(leagueState);", later)
        self.assertNotIn("isNativeApp()", later, "the native paths are handled above")


class ScheduleTabTests(unittest.TestCase):
    """A tab tap is answered on the tap, and a week costs nothing until opened."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()

    def test_every_tab_acknowledges_the_tap_before_working(self):
        nav = self.app[self.app.index("async function navigateToView(view)"):]
        nav = nav[:nav.index("\n}")]
        self.assertIn("if (paintShell(view)) await nextPaint();", nav)
        self.assertLess(nav.index("paintShell(view)"), nav.index("render({ scrollTop: true })"))
        # The rule is not Schedule-only: every view has a shell.
        shells = self.app[self.app.index("const VIEW_SHELLS = {"):self.app.index("const loadingLine =")]
        for view in ("schedule", "picks", "league", "today", "rules"):
            self.assertIn(f"{view}:", shells, view)

    def test_the_schedule_shell_is_the_header_and_filters_only(self):
        shells = self.app[self.app.index("const VIEW_SHELLS = {"):self.app.index("const loadingLine =")]
        self.assertIn("scheduleHead()", shells)
        self.assertIn("scheduleFilters()", shells)
        self.assertIn('loadingLine("Loading fixtures…")', shells)
        # Nothing heavy: no fixture cards, no week bodies.
        self.assertNotIn("groupedPeriods", shells)
        self.assertNotIn("matchCard", shells)
        self.assertIn(".view-loading", self.css)

    def test_the_shell_bypasses_the_tap_hold_and_the_dedupe(self):
        paint = self.app[self.app.index("function paintShell(view)"):]
        paint = paint[:paint.index("\n}")]
        # render() is held for the length of a tap, and a tab tap is a tap.
        self.assertNotIn("render(", paint)
        self.assertIn("app.innerHTML = shell();", paint)
        self.assertIn("renderedHTML = null;", paint)
        self.assertIn("markActiveTab();", paint)

    def test_the_pause_is_long_enough_to_actually_paint(self):
        line = self.app[self.app.index("const nextPaint ="):]
        line = line[:line.index("\n")]
        self.assertIn("requestAnimationFrame", line)
        self.assertIn("setTimeout(resolve, 0)", line)

    def test_a_closed_week_builds_no_cards(self):
        body = self.app[self.app.index("function dayBody(period, matches, open)"):]
        body = body[:body.index("\n}")]
        self.assertIn('if (!open) return `<div class="day-body" data-lazy-body=', body)
        self.assertIn('matches.map(matchCard).join("")', body)

    def test_expanding_builds_that_week_on_demand(self):
        fill = self.app[self.app.index("function fillDayBody(card)"):]
        fill = fill[:fill.index("\n}")]
        self.assertIn('const body = card.querySelector("[data-lazy-body]");', fill)
        self.assertIn("if (!body) return;", fill)
        self.assertIn('body.removeAttribute("data-lazy-body");', fill)
        # Same card builder as the eager path, so calendar and TV info cannot drift.
        self.assertIn('matches.map(matchCard).join("")', fill)
        toggle = self.app[self.app.index('document.addEventListener("toggle"'):]
        self.assertIn("fillDayBody(card);", toggle)

    def test_the_list_is_walked_once(self):
        group = self.app[self.app.index("function groupedPeriods(list, currentPeriod = null)"):]
        group = group[:group.index("\n}")]
        self.assertNotIn("list.filter", group)
        self.assertIn("byPeriod(list)", group)

    def test_filtering_to_a_week_opens_it(self):
        handler = self.app[self.app.index('const filter = event.target.closest("[data-filter]");'):]
        handler = handler[:handler.index("const league = event.target.closest")]
        self.assertIn('if (matchdayFilter !== "all") openScheduleDates.add(`md-${matchdayFilter}`);', handler)


class NamesAndViewportTests(unittest.TestCase):
    """Build 12: nobody is Anon by accident, and the keyboard cannot leave the
    page displaced."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()
        cls.html = (ROOT / "index.html").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()

    # --- A. names ---------------------------------------------------------

    def test_the_join_form_asks_for_a_name(self):
        view = self.app[self.app.index("function leagueView()"):]
        view = view[:view.index("function rulesView()")]
        self.assertIn('<input id="joinNick" name="joinNick" maxlength="24"', view)
        # Prefilled with whatever is already known, and required either way.
        self.assertIn('value="${escapeHTML(playerName)}"', view)
        self.assertIn("required", view)
        self.assertIn("This is what your mates will see", view)

    def test_joining_sends_the_name_and_keeps_it(self):
        handler = self.app[self.app.index('if (event.target.matches("[data-join-league]")) {'):]
        handler = handler[:handler.index("if (event.target.matches(\"[data-restore]\"))")]
        self.assertIn('const nick = String(data.get("joinNick") || "").trim().slice(0, 24);', handler)
        self.assertIn('api("/join", { uid: uid(), nickname: playerName || nick, nick, code })', handler)
        # A first-time joiner ends up with a profile name too.
        self.assertIn("if (!playerName) {", handler)
        self.assertIn("localStorage.setItem(STORAGE.name, playerName);", handler)

    def test_saving_a_profile_name_reaches_the_server(self):
        self.assertIn("syncProfileName();", self.app)
        fn = self.app[self.app.index("async function syncProfileName()"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn('api("/profile", { uid: uid(), nickname: playerName })', fn)
        # Only the leagues the server says it changed are repainted.
        self.assertIn("for (const code of result.updated || []) applyNickLocally(code, uid(), result.nickname);", fn)

    def test_a_name_held_from_before_still_reaches_the_server(self):
        # Everyone already carrying a display name would otherwise stay "Anon"
        # in their leagues until they happened to re-save it.
        self.assertIn(
            "if (playerName && localStorage.getItem(STORAGE.syncedName) !== playerName) syncProfileName();",
            self.app,
        )
        self.assertIn('syncedName: "prem_oracle_synced_name",', self.app)
        # Once per name, not once per launch.
        fn = self.app[self.app.index("async function syncProfileName()"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn("localStorage.setItem(STORAGE.syncedName, playerName);", fn)
        self.assertLess(fn.index('api("/profile"'), fn.index("STORAGE.syncedName"))

    def test_the_profile_dialog_explains_the_split(self):
        self.assertIn("Used in your leagues unless you set a league name.", self.html)
        self.assertIn(".field-hint", self.css)

    def test_the_server_only_replaces_the_default_nick(self):
        fn = self.worker[self.worker.index("async function setProfile(env, body)"):]
        fn = fn[:fn.index("\nasync function updateLeagueNick")]
        self.assertIn("if (member.nick && member.nick !== DEFAULT_NICK) { kept.push(code); continue; }", fn)
        self.assertIn("nick: nickname", fn)
        # One definition of the default, shared with the fallback that creates it.
        self.assertIn("DEFAULT_NICK,", self.worker)
        logic = (ROOT / "worker/src/logic.js").read_text()
        self.assertIn('export const DEFAULT_NICK = "Anon";', logic)
        self.assertIn("|| DEFAULT_NICK;", logic)

    def test_join_prefers_the_name_given_for_that_league(self):
        fn = self.worker[self.worker.index("async function joinLeague(env, body)"):]
        fn = fn[:fn.index("\n}")]
        self.assertIn('const offered = String(body.nick || body.nickname || "").trim();', fn)
        self.assertIn("nick: offered ? normNick(offered) : (user.nickname || existing?.nick || DEFAULT_NICK),", fn)

    def test_renaming_uses_a_real_field_not_a_prompt(self):
        # prompt() returns null both when WKWebView declines to show it and when
        # the viewer cancels, so a rename could fail with no feedback at all.
        code_only = re.sub(r"//[^\n]*", "", self.app)   # comments may name it
        self.assertNotIn("prompt(", code_only)
        self.assertIn('<dialog id="nickDialog">', self.html)
        self.assertIn('<input id="leagueNick" name="leagueNick" maxlength="24"', self.html)
        self.assertIn("required", self.html[self.html.index('id="leagueNick"'):self.html.index("</dialog>", self.html.index('id="leagueNick"'))])
        handler = self.app[self.app.index('const nick = event.target.closest("[data-league-nick]");'):]
        handler = handler[:handler.index("const kick = event.target.closest")]
        self.assertIn("openNickDialog(nick.dataset.leagueNick);", handler)

    def test_a_failed_rename_always_says_so(self):
        fn = self.app[self.app.index('document.getElementById("nickForm").addEventListener'):]
        fn = fn[:fn.index("document.getElementById(\"nickDialog\").addEventListener")]
        self.assertIn('api("/league/nick", { uid: uid(), code, nick: trimmed })', fn)
        self.assertIn('setFlash(error.message, "error");', fn)
        self.assertIn("applyNickLocally(code, uid(), result.nick);", fn)
        # And it prefills with the name in force for that league.
        opener = self.app[self.app.index("function openNickDialog(code)"):]
        opener = opener[:opener.index("\n}")]
        self.assertIn("leagueState?.table?.find((row) => row.uid === uid())?.nick || playerName", opener)
        self.assertIn("dialog.showModal();", opener)

    # --- B. the viewport --------------------------------------------------

    def test_the_keyboard_cannot_leave_the_page_displaced(self):
        fn = self.app[self.app.index("function restoreViewport()"):]
        fn = fn[:fn.index("\n}\n")]
        self.assertIn("window.scrollTo(0, 0);", fn)
        self.assertIn("document.scrollingElement.scrollTop = 0;", fn)
        self.assertIn("document.body.scrollTop = 0;", fn)
        # The keyboard animates out, so one correction is not enough.
        self.assertIn("requestAnimationFrame(settle);", fn)
        for delay in ("60", "250", "600"):
            self.assertIn(f"setTimeout(settle, {delay});", fn)

    def test_every_way_the_keyboard_closes_restores_the_viewport(self):
        # Submitting, cancelling, Escape and the close button.
        self.assertIn('document.getElementById("profileDialog").addEventListener("close", restoreViewport);', self.app)
        dismiss = self.app[self.app.index("function dismissKeyboard()"):]
        dismiss = dismiss[:dismiss.index("\n}")]
        self.assertIn("restoreViewport();", dismiss)
        # And a safety net for any scroll at all, since the app never scrolls
        # the document itself.
        self.assertIn('window.addEventListener("scroll", () => {', self.app)
        self.assertIn("if (window.scrollY || document.scrollingElement?.scrollTop) restoreViewport();", self.app)
        # The visual viewport returning to full height is the keyboard leaving.
        self.assertIn("if (vv.height >= tallest - 1) restoreViewport();", self.app)

    def test_viewport_scale_is_reported_not_silently_absorbed(self):
        # Scale and offset look alike in a screenshot and are nothing alike
        # underneath: a scroll correction cannot undo page zoom. The numbers
        # are recorded so a scale fault is visible in the next report.
        fn = self.app[self.app.index("function viewportReport()"):]
        fn = fn[:fn.index("\n}")]
        for field in ("scale:", "vvWidth:", "offsetTop:", "innerWidth:", "screenWidth:", "dpr:", "rootFontPx:"):
            self.assertIn(field, fn, field)
        restore = self.app[self.app.index("function restoreViewport()"):]
        restore = restore[:restore.index("\n}\n")]
        self.assertIn('console.warn("Prem Oracle: viewport is scaled", report);', restore)
        self.assertIn("Math.abs(report.scale - 1) > 0.01", restore)
        # Reachable from a support session without a debugger attached.
        self.assertIn("window.premOracleViewport = viewportReport;", self.app)

    def test_diagnostics_are_local_only_and_carry_no_identity(self):
        # The App Privacy label declares no diagnostic collection, and this
        # keeps that true: the viewer copies it and sends it themselves.
        fn = self.app[self.app.index("function diagnosticsText()"):]
        fn = fn[:fn.index("\n}")]
        for identifier in ("uid(", "STORAGE.uid", "activeLeague", "playerName", "leagueCodes", "recovery"):
            self.assertNotIn(identifier, fn, identifier)
        # And nothing transmits it.
        handler = self.app[self.app.index('if (!event.target.closest("[data-copy-diagnostics]")) return;'):]
        handler = handler[:handler.index("});")]
        self.assertIn("navigator.clipboard?.writeText(text)", handler)
        for transmit in ("fetch(", "api(", "XMLHttpRequest", "sendBeacon"):
            self.assertNotIn(transmit, handler, transmit)
        self.assertIn("data-copy-diagnostics", self.html)

    def test_zoom_is_not_disabled(self):
        # Locking scale would be an accessibility regression, and nothing has
        # yet shown it would even address the cause.
        meta = self.html[self.html.index('name="viewport"'):]
        meta = meta[:meta.index(">")]
        self.assertIn("width=device-width", meta)
        self.assertIn("viewport-fit=cover", meta)
        self.assertNotIn("maximum-scale", meta)
        self.assertNotIn("user-scalable", meta)

    def test_the_body_stays_one_viewport_tall_and_unscrolled(self):
        # Pinning the documentElement as well was tried and dropped: the
        # simulator showed it changed nothing, and restoreViewport() is what
        # actually puts the page back.
        body = self.css[self.css.index("body {"):]
        body = body[:body.index("}")]
        self.assertIn("overflow: hidden;", body)
        # position: fixed on the body is still deliberately absent — it breaks
        # iOS Full Keyboard Access, which is a worse bug.
        self.assertNotIn("position: fixed;", body)

    def test_both_slate_states_are_the_same_height(self):
        # The slot holds either "Pick fixtures" or the published lock line plus
        # "Edit line-up", and swaps between them when a stale cached card is
        # replaced by fresh state. Styling both to one height means the buttons
        # below never move, and nothing is held open when the slot is empty.
        # Measured: those three buttons moved 48px stacked, 0px like this.
        view = self.app[self.app.index("function leagueView()"):]
        view = view[:view.index("function rulesView()")]
        self.assertIn('<div class="slate-slot">${hostSlateControl(state)}</div>', view)
        # No reserved empty space: the slot is a plain wrapper with no rule of
        # its own, so an empty one costs nothing.
        self.assertNotIn(".slate-slot {", self.css)

        published = self.css[self.css.index(".slate-notice-published {"):]
        published = published[:published.index("}")]
        self.assertIn("display: flex;", published)      # one row, not stacked
        self.assertIn("align-items: center;", published)
        self.assertIn("min-height: 50px;", published)   # the button's own height
        self.assertIn("margin: 0 0 12px;", published)   # the button's own margin
        banner = self.css[self.css.index(".host-slate-banner {"):]
        self.assertIn("margin: 0 0 12px;", banner[:banner.index("}")])
        # The lock line gives way to the button rather than pushing it down.
        lock = self.css[self.css.index(".lock-line {"):]
        lock = lock[:lock.index("}")]
        self.assertIn("flex: 1;", lock)
        self.assertIn("margin: 0 !important;", lock)

        # The slot sits above the action buttons, which is the whole point.
        self.assertLess(view.index("slate-slot"), view.index("data-share-league"))
        self.assertLess(view.index("slate-slot"), view.index("data-league-nick"))

    # --- C. the nav -------------------------------------------------------

    def test_inactive_nav_icons_are_visibly_dimmed(self):
        span = self.css[self.css.index(".bottom-nav button span {"):]
        span = span[:span.index("}")]
        self.assertIn("filter: grayscale(1);", span)
        # Greyscale alone cannot dim a football, which is already monochrome.
        self.assertIn("opacity: .45;", span)
        active = self.css[self.css.index(".bottom-nav button.active span {"):]
        active = active[:active.index("}")]
        self.assertIn("filter: none;", active)
        self.assertIn("opacity: 1;", active)


if __name__ == "__main__":
    unittest.main()
