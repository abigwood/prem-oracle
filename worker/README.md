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

## Kick-off push reminders

A cron trigger (`*/15 * * * *`, see `wrangler.toml`) runs `scheduled()`, which
finds fixtures kicking off within the next 60 minutes that have not been
notified yet, and sends an Apple Push Notification to every stored device token
(`push:<uid>` KV entries). Sent fixtures are recorded under `notified:<matchId>`
(2-day TTL) so each kick-off is announced once. A `410 Unregistered` response
from APNs deletes the stale `push:<uid>` token. If the `APNS_*` secrets below
are not configured the send path is skipped entirely, so the Worker runs fine
without them.

The APNs topic is `com.abigwood.premoracle` and pushes go to the production
host `https://api.push.apple.com`.

### Secrets

Create an APNs Auth Key (`.p8`) in the Apple Developer portal
(Certificates, Identifiers & Profiles -> Keys -> new key with the
Apple Push Notifications service enabled), then set:

```bash
# Contents of the AuthKey_XXXXXXXXXX.p8 file (the PKCS#8 PEM, BEGIN/END lines included)
wrangler secret put APNS_KEY
# The 10-character Key ID shown next to the key
wrangler secret put APNS_KEY_ID
# Your 10-character Apple Developer Team ID
wrangler secret put APNS_TEAM_ID
```

The provider JWT is signed with ES256 and cached for ~50 minutes (Apple rejects
tokens older than 60).

Run tests:

```bash
npm test
```
