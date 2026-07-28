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
        self.assertIn("styles.css?v=20260728a", html)
        self.assertIn("app.js?v=20260728a", html)
        self.assertIn("prem-oracle-v1-20260728a", sw)
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

    def test_all_twenty_clubs_have_markers(self):
        self.assertEqual(len(self.markers), 20)

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
            'countPhrase(38, "Matchweeks")',
            'class="tour-badge">Matchweek ',
            "Opening matchweek",
            "Next matchweek",
            "MW ${value}",
            "🏆 Matchweek ",
            "Matchweek ${md} \u25be",
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


class CustomMixTests(unittest.TestCase):
    """v1.2: the host-curated slate, from the creation toggle to the picker."""

    @classmethod
    def setUpClass(cls):
        cls.app = (ROOT / "app.js").read_text()
        cls.css = (ROOT / "styles.css").read_text()
        cls.worker = (ROOT / "worker/src/worker.js").read_text()
        cls.logic = (ROOT / "worker/src/logic.js").read_text()

    def test_custom_mix_is_opt_in_at_league_creation(self):
        self.assertIn('<strong>Custom matchweek picks</strong>', self.app)
        self.assertIn('name="customMix"', self.app)
        # Off by default: no `checked`, and the flag is only sent when ticked.
        toggle = self.app[self.app.index('name="customMix"'):][:120]
        self.assertNotIn("checked", toggle)
        self.assertIn('const customMix = form.get("customMix") != null;', self.app)
        # Existing leagues are untouched — the worker defaults the flag to false.
        self.assertIn("const customMix = body.customMix === true;", self.worker)

    def test_picker_offers_six_to_ten_with_surprise_me_and_use_all(self):
        self.assertIn("const SLATE_MIN = 6;", self.app)
        self.assertIn("const SLATE_MAX = 10;", self.app)
        self.assertIn("Select ${SLATE_MIN}–${SLATE_MAX} · ${count} selected", self.app)
        self.assertIn("data-picker-surprise", self.app)
        self.assertIn("Surprise me", self.app)
        self.assertIn("Use all ${list.length} this week", self.app)
        self.assertIn("Set ${count} fixtures", self.app)
        # The CTA only activates from six selections.
        self.assertIn("count < SLATE_MIN || count > SLATE_MAX ? \"disabled\" : \"\"", self.app)

    def test_surprise_me_deals_an_editable_random_eight(self):
        self.assertIn("const SURPRISE_COUNT = 8;", self.app)
        self.assertIn("Math.min(SURPRISE_COUNT, pool.length)", self.app)
        # Applied as an ordinary selection: same mode, so every card stays tappable.
        surprise = self.app[self.app.index("[data-picker-surprise]"):][:260]
        self.assertIn("pickerSelection = surpriseSelection(pickerFixtures())", surprise)
        self.assertIn('pickerMode = "custom"', surprise)

    def test_setting_a_slate_needs_one_confirmation_that_says_it_is_final(self):
        self.assertIn("Your league cannot change them after this.", self.app)
        self.assertIn("data-picker-commit", self.app)
        self.assertIn("picker-confirm-scrim", self.css)
        # Use-all-10 is an explicit full-week record, not a silent absence.
        use_all = self.app[self.app.index('[data-picker-all]'):][:220]
        self.assertIn('pickerMode = "full"', use_all)

    def test_members_get_a_calm_waiting_state_then_fewer_cards(self):
        self.assertIn("Waiting for ${escapeHTML(hostNickname())} to set this week's fixtures", self.app)
        self.assertNotIn("spinner", self.app)
        # Only the slate fixtures are rendered once it is set.
        self.assertIn("dayMatches = dayMatches.filter((fixture) => chosen.has(String(fixture.id)))", self.app)
        self.assertIn("You've picked ${pickedCount} of ${roundFixtures.length}", self.app)

    def test_host_banner_names_the_matchweek(self):
        self.assertIn("Pick fixtures for Matchweek ${matchweek}", self.app)
        self.assertIn("Pick fixtures for Matchweek ${state.currentMatchday}", self.app)

    def test_worker_routes_and_storage_key(self):
        for route in ("/league/slate", "/league/custom-mix", "/account/delete"):
            self.assertIn(f'path === "{route}"', self.worker)
        self.assertIn("`custom_slate:${code}:${matchweek}`", self.logic)
        # Immutable once set.
        self.assertIn('return json({ error: "this matchweek\'s fixtures are already set", slate: existing }, 409, env);', self.worker)

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
        self.assertIn("Matchweek ${md} complete — won by", self.app)
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
        for phrase in ('countPhrase(38, "Matchweeks")',
                       'countPhrase(380, "fixtures")',
                       '<span class="nowrap">Game ${homeMatchday} of 38</span>',
                       '<span class="nowrap">Game ${md} of 38 ·</span>'):
            self.assertIn(phrase, self.app, phrase)
        # The separator rides inside the wrapper, so a line never opens with "·".
        self.assertNotIn("of 38</span> ·", self.app)


if __name__ == "__main__":
    unittest.main()
