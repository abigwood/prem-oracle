# Raw source data (committed for reproducible, offline builds)

These CSVs are the historical inputs for the Prem Oracle forecast model
(`scripts/build_intel.mjs`). They are committed to the repo so the intel build
is fully reproducible without any network access or paid services.

| File | Competition | Season | Source |
|------|-------------|--------|--------|
| `E0_2526.csv` | Premier League | 2025/26 | https://www.football-data.co.uk/mmz4281/2526/E0.csv |
| `E1_2526.csv` | EFL Championship | 2025/26 | https://www.football-data.co.uk/mmz4281/2526/E1.csv |

- **Provider:** football-data.co.uk (free historical results & odds archive).
- **Fetched:** 2026-07-26 (both seasons complete: E0 380 matches, E1 552 matches).
- **Format:** standard football-data.co.uk columns. The build only uses
  `Div, Date, Time, HomeTeam, AwayTeam, FTHG, FTAG, FTR`.
- **License/usage:** football-data.co.uk data is free to use; please keep the
  attribution above. See https://www.football-data.co.uk/notes.txt.

## Refreshing

To re-pull the raw files (e.g. a corrected upload), overwrite in place:

```sh
curl -o data/source/E0_2526.csv https://www.football-data.co.uk/mmz4281/2526/E0.csv
curl -o data/source/E1_2526.csv https://www.football-data.co.uk/mmz4281/2526/E1.csv
```

Then re-run `node scripts/build_intel.mjs`. In-season (2026/27) results are
folded in separately via `--refresh` (football-data.org), not from these files.
