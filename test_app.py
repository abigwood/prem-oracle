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
        self.assertIn("styles.css?v=20260714a", html)
        self.assertIn("app.js?v=20260714a", html)
        self.assertIn("prem-oracle-v1-20260714a", sw)
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
        self.assertIn("Illustrative form", app)
        self.assertIn("fixtureDayDiff(match) > 7", app)
        self.assertIn("flash-error", css)
        self.assertIn("setupNativePushNotifications", app)
        self.assertIn("/push-token", app)
        self.assertIn("TEAM_INTEL", app)
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


if __name__ == "__main__":
    unittest.main()
