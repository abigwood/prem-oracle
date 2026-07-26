import json
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
        self.assertIn("styles.css?v=20260726b", html)
        self.assertIn("app.js?v=20260726b", html)
        self.assertIn("prem-oracle-v1-20260726b", sw)
        self.assertIn("https://prem-oracle-window.abigwood.workers.dev", html)
        self.assertIn("vendor/capacitor/push-notifications.js", html)

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
        self.assertIn('"Arsenal": { bg: "#EF0107"', app)
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
        self.assertIn("teams: fixtureIntel.teams", self.worker)

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
            self.assertGreaterEqual(draw, 18, fixture["id"])
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
            self.assertGreaterEqual(intel["rating"], 45, name)
            self.assertLessEqual(intel["rating"], 95, name)

    def test_promoted_teams_get_plausible_ratings(self):
        teams = self.data["teams"]
        top_rating = max(t["rating"] for t in teams.values())
        for name in PROMOTED_TEAMS:
            self.assertIn(name, teams)
            rating = teams[name]["rating"]
            # Promoted sides seeded from the Championship with a handicap: a
            # plausible newcomer band, and never the strongest team in the league.
            self.assertGreaterEqual(rating, 45, name)
            self.assertLessEqual(rating, 72, name)
            self.assertLess(rating, top_rating, name)
            self.assertIn("Championship", teams[name]["basis"], name)


if __name__ == "__main__":
    unittest.main()
