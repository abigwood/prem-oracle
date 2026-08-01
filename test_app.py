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
        self.assertIn("styles.css?v=20260731a", html)
        self.assertIn("app.js?v=20260731a", html)
        self.assertIn("prem-oracle-v1-20260731a", sw)
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
            "MW ${value}",
            "Matchweek ${escapeHTML(period)} is open",
            "🏆 ${competition} ${week}",
            "${escapeHTML(periodLabel(period))} \u25be",
            "Share Matchweek ",
            "Loading matchweek",
            'aria-label="Choose matchweek"',
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
        step = step[:step.index("function wizardStepRule()")]
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
        self.assertIn("`${API}/fixtures?competition=${code}&", self.app)
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

    def test_setting_a_slate_needs_one_confirmation_that_says_it_is_final(self):
        self.assertIn("Your league cannot change them after this.", self.app)
        self.assertIn("Publish these ${count} fixtures?", self.app)
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
        # A matchweek for a single competition, a week window for a mix.
        self.assertIn("Pick fixtures for ${escapeHTML(periodLabel(period))}", self.app)
        self.assertIn("Pick fixtures for ${escapeHTML(periodLabel(state.currentPeriod))}", self.app)

    def test_worker_routes_and_storage_key(self):
        for route in ("/league/slate", "/league/custom-mix", "/account/delete"):
            self.assertIn(f'path === "{route}"', self.worker)
        # Slates key on a period: a matchweek number, or a window like w2026-08-10.
        self.assertIn("`custom_slate:${code}:${period}`", self.logic)
        # Immutable once set.
        self.assertIn('json({ error: "this matchweek\'s fixtures are already set", slate: normaliseSlate(existing) }, 409, env)', self.worker)

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
        self.assertIn('const WIZARD_STEPS = ["name", "competitions", "rule", "share"];', self.app)
        for step in ("wizardStepName", "wizardStepCompetitions", "wizardStepRule", "wizardStepShare"):
            self.assertIn(f"function {step}()", self.app, step)
        self.assertIn("<h3>Name your league</h3>", self.app)
        self.assertIn("<h3>Choose competitions</h3>", self.app)
        self.assertIn("<h3>Your weekly rule</h3>", self.app)
        self.assertIn("<h3>Share your code</h3>", self.app)
        self.assertIn(".wizard-progress", self.css)

    def test_the_competition_step_uses_the_green_selected_state(self):
        # v1.4.1: pale purple -> pale green, the same family as the rule cards.
        self.assertIn(
            ".competition-option input:checked + span { border-color: var(--green); color: var(--green-2); background: #eaf7f1; }",
            self.css)
        self.assertNotIn(".competition-option input:checked + span { border-color: var(--purple)", self.css)
        self.assertIn("competition-option${wizard.competitions.includes(code)", self.app)
        # And the rule cards it now matches.
        self.assertIn(".rule-option.is-selected { border-color: var(--green); background: #eaf7f1; }", self.css)

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

    def test_every_weekly_rule_the_spec_names_is_offered(self):
        options = self.app[self.app.index("function ruleOptions()"):]
        options = options[:options.index("const wizardOptionSelected")]
        self.assertIn("I'll pick each week", self.app)
        self.assertIn("All fixtures", self.app)
        self.assertIn("Random weekly", self.app)
        self.assertIn("All ${competitionMeta(code).short}", options)
        self.assertIn("App picks ${wizard.count} random", self.app)
        for method in ("manual", "allEligible", "allCompetition", "random"):
            self.assertIn(f'"{method}"', options, method)

    def test_the_scope_is_explicit_and_never_inferred(self):
        rule = self.app[self.app.index("function wizardRule()"):]
        rule = rule[:rule.index("const WEEKLY_RULE_LABEL")]
        self.assertIn("competitionScope", rule)
        self.assertIn('mixed ? "mixed" : wizard.competitions[0]', rule)
        # And the same shape is enforced server-side.
        self.assertIn("export function validateWeeklyRule(input, competitions)", self.competitions)
        self.assertIn('return { error: "allCompetition needs a single competition scope" };', self.competitions)
        self.assertIn('"allEligible covers every competition the league plays"', self.competitions)

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
        self.assertIn("list.map(periodOfFixture)", self.app)

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
        self.assertIn("async function autoPublish(env, league, period, pool)", self.worker)
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
        grouped = self.app[self.app.index("function groupedPeriods(list, currentPeriod = null)"):]
        grouped = grouped[:grouped.index("// My Picks still groups by matchweek")]
        self.assertIn('String(period) === String(current)', grouped)
        self.assertIn("<details", grouped)
        # Every period is rendered; only the open attribute varies.
        self.assertNotIn("filter((period) =>", grouped)

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
        self.assertIn("cacheLeagueState(leagueState);", loader)
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


if __name__ == "__main__":
    unittest.main()
