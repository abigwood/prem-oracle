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
