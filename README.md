# Prem Oracle

A Premier League 2026/27 score predictor based on the SW19 Oracle league model.

## Prediction scope

- 38 matchdays.
- 380 Premier League fixtures.
- Each player predicts the final score for every fixture before scheduled kick-off.

## Scoring

- Exact score: 5 points.
- Correct draw, wrong score: 2 points.
- Correct winner and correct goal difference: 2 points.
- Correct winner only: 1 point.
- Wrong outcome, no pick, or void fixture: 0 points.

## Public architecture

- Static PWA shell.
- Optional shared leagues via Cloudflare Worker and KV.
- Fixtures seeded from the official Premier League 2026/27 fixture release.
- No paid API dependency.
- Results are settled manually through the Worker `/settle` endpoint until a
  live Premier League results feed is configured.

Official source:

- https://www.premierleague.com/en/news/4675097/all-380-fixtures-for-202627-premier-league-season

## Forecast model (v1.1)

The Oracle forecast is an in-house model (home advantage + rating difference +
recent form). Ratings are seeded from real 2025/26 final league performance;
the three promoted clubs (Coventry City, Hull City, Ipswich Town) are seeded
from their 2025/26 Championship record with a division handicap. Form is each
team's last 6 league games, most recent last.

- Raw inputs are committed under `data/source/` so the build is reproducible
  offline (football-data.co.uk season CSVs — free, no API key).
- `scripts/build_intel.mjs` wires per-fixture `probabilities` `[home, draw,
  away]` (integers summing to 100) plus a top-level `teams` intel block,
  `modelVersion`, and `generatedAt` into `data/fixtures.json`.
- Shared, testable model logic lives in `worker/src/forecast.mjs`.

```bash
npm run build:fixtures   # scrape the 380-fixture list (premierleague.com)
npm run build:intel      # add ratings/form/probabilities (offline, from CSVs)
```

In-season rolling updates fold 2026/27 results in via football-data.org (free
tier) and re-run the pipeline. Run `npm run build:intel:refresh` locally with
`FOOTBALL_DATA_TOKEN` set, or let the scheduled GitHub Action
(`.github/workflows/refresh-intel.yml`) commit changes automatically — it needs
a `FOOTBALL_DATA_TOKEN` repository secret and is a no-op until matchday 1.

## Run

```bash
python3 server.py
```

Open `http://127.0.0.1:8899/`.

## Test

```bash
python3 -m unittest -v test_app.py
node --check app.js
cd worker && npm test
```

## Native iOS wrapper

The App Store wrapper is a Capacitor iOS project in `ios/`.

```bash
npm install
npm run native:sync
npm run native:open
```

Native push registration is wired with `@capacitor/push-notifications`; iOS
uses `ios/App/App/App.entitlements` and the AppDelegate APNs callbacks. Device
tokens are stored by the Worker via `/push-token` so kick-off reminders can be
sent once the APNs sender credentials/result-reminder job are configured.
