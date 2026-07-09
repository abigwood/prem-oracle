# Prem Oracle backend

Separate Cloudflare Worker and KV namespace for Prem Oracle. It never reads or
writes Kickoff Oracle or SW19 Oracle KV data.

Scoring: exact football score 5; correct draw or correct winner plus goal
difference 2; correct winner only 1. Picks are checked and locked server-side
at `startAt`.

Result settlement is manual until a real Premier League results feed is wired.
Post the full result overlay map to `/settle` with `SETTLE_SECRET`; accepted
entries are `{"status":"complete","result":[homeGoals,awayGoals]}` or a void
status of `postponed`, `cancelled`, or `abandoned`.

Run tests:

```bash
npm test
```
