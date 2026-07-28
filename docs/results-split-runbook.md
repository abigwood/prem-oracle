# Results-split migration — supervised production runbook

Ordered commands for the supervised session, with the output to expect at each
step and the criteria for stopping. Nothing here runs automatically: every
stage is an explicit call, and the two that change behaviour (`copy`, `freeze`)
are called out.

Per Ashton's confirmed reading of §5b: this is **copy-and-freeze**. The
intermediate stages are evidence gates, not switches. Nothing ever writes the
legacy key, so there is no bridge period to run.
Settlement and read paths are competition-key aware from stage one.

## Before you start

| Prerequisite | Check |
|---|---|
| Worker deployed with the v1.3 build | `git log --oneline -1` matches the reviewed commit |
| `MIGRATION_SECRET` set | `npx wrangler secret list` shows it |
| Fresh snapshot taken | `.migration-snapshots/prod-kv-*.json` from today |
| Local evidence green | `node scripts/parity_evidence.mjs` → GATE MET |
| Full suite green | `npm run verify` → 0 failures |

```sh
export API=https://prem-oracle-window.abigwood.workers.dev
export SECRET='<MIGRATION_SECRET>'
mig () { curl -sS -X POST "$API/admin/migration" -H 'content-type: application/json' \
  -d "{\"secret\":\"$SECRET\",\"action\":\"$1\",\"stage\":\"$2\",\"commit\":${3:-false}}" | python3 -m json.tool; }
```

### Operational note — wait out the fixture cache before spot-checking

The worker caches each competition's fixture list for **60 seconds**, and
`/state` reads that cache. After any stage transition, a manual check made
inside that window can return pre-transition data and look like a false pass —
or, worse, mask a real gap.

After every `mig run ... true`, do one of:

- wait **more than 60 seconds** before checking anything, or
- cache-bust deliberately: `curl -sS "$API/fixtures?refresh=1" >/dev/null`
  first, then run the check.

This bit us during evidence-gathering: the dual-read fallback check appeared to
pass at `freeze` with an entry deliberately missing from `results:PL`, purely
because `/state` was serving a stale cached list. The harness avoids it by
driving every transition through `/admin/migration`, which clears the cache;
a human operator with a terminal does not get that for free.

Take the snapshot first. It is the rollback artefact of last resort and it is
the input to the evidence run.

```sh
cd worker
npx wrangler kv key list --namespace-id=4d6fa971722242a69e1644725ef2b11b --remote > /tmp/keys.json
# then scripts/snapshot_kv (or the inline loop used to produce the current snapshot)
```

## Step 0 — status

```sh
mig status
```

Expect `{"ok": true, "stage": "inventory", "history": []}` on a first run. If
`stage` is anything else, someone has already started: **stop** and reconcile
before going further.

## Step 1 — inventory (read-only)

```sh
mig run inventory
```

Expect `evidence.legacyEntries` to equal the settled-fixture count you believe
production holds, `byCompetition` to be `{"PL": n, "ELC": 0, "CL": 0}`, and
`unnamespaced` to be `[]`.

**Abort if** `unnamespaced` is non-empty. Those ids name no competition and the
copy will skip them; they must be understood before anything is written.

**Abort if** `byCompetition.ELC` or `.CL` is non-zero on the legacy key. The
legacy object is Premier League only; anything else in it is a surprise.

## Step 2 — copy (**writes** `results:PL`)

This is the first of the two stages that change anything.

```sh
mig run copy true
```

Expect `evidence.legacyUntouched: true`, `evidence.copied.PL` equal to the
inventory count, and `evidence.written["results:PL"].entries` equal to it too.

**Abort if** `legacyUntouched` is false. That should be impossible —
`assertNotLegacyResultsKey` guards every write — but if it is ever false, stop
and do not proceed to freeze.

## Step 3 — verify (read-only, repeatable)

```sh
mig run verify
```

Expect `evidence.match: true`, and for each competition
`expectedHash === actualScopedHash` with `differences: []`.

**Abort if** `match` is false. Read `differences`: `score differs` or `status
differs` means the copy is not faithful; `missing from target` means an entry
did not copy. Re-run `copy` and verify again. Do not freeze on a failed verify —
freeze is what removes the legacy fallback that is currently covering the gap.

Run this as many times as you like. It writes nothing.

## Steps 4–6 — dual-read, switch, scoped-write-proof (evidence gates)

```sh
mig run dual-read true
mig run switch true
mig run switch          # re-run without commit to re-read the plan
mig run scoped-write-proof true
```

Each returns the read and write plan in force. Expect
`readKeys.PL: ["results:PL", "results"]` and
`writeKeys.PL: "results:PL"` throughout.

These record intent and let you pause for observation between them. **None of
them changes behaviour** — reads have consulted `results:PL` first since stage
one, because writes have gone there since stage one. Sit at `switch` for a
release cycle if you want the soak; the system is already in its post-switch
read configuration.

Between them, spot-check production — remembering the 60-second cache note
above:

```sh
curl -sS "$API/fixtures?refresh=1" >/dev/null   # cache-bust first
curl -sS "$API/state?code=<LEAGUE>" | python3 -m json.tool | head -30
curl -sS "$API/fixtures" | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d['fixtures']), d['modelVersion'])"
```

**Abort if** any league table, points total, rank or matchweek winner differs
from what it showed before Step 2.

## Step 7 — freeze (**changes reads**)

Only after `verify` reports `match: true` on a run you have just done.

```sh
mig run verify          # once more, immediately before
mig run freeze true
```

Expect `evidence.legacyRetained: true`, `legacyEntries` unchanged from Step 1,
and `readKeys.PL: ["results:PL"]`.

Freeze removes the legacy key from the read path. From here, anything the copy
missed becomes invisible. That is why verify runs immediately beforehand.

Immediately after, cache-bust and re-check the same leagues and fixture counts
as above. A check made inside the 60-second window proves nothing.

## Rollback

```sh
mig rollback
```

Returns reads to the pre-switch plan. There is nothing to undo: the legacy
object has never been written, so it is byte-identical to its pre-migration
state. Verify:

```sh
mig status                                      # stage back to "inventory"
curl -sS "$API/fixtures?refresh=1" >/dev/null   # cache-bust
curl -sS "$API/state?code=<LEAGUE>"             # identical to baseline
```

Rollback is safe at any point, including after freeze.

## Abort criteria, consolidated

Stop immediately and roll back if any of these hold:

1. `unnamespaced` is non-empty at inventory.
2. `legacyUntouched` is ever false.
3. `verify` reports `match: false` and re-running `copy` does not clear it.
4. Any league table, points total, rank, movement value or matchweek winner
   changes at any step.
5. `/fixtures` returns a different fixture count or `modelVersion`.
6. A settlement lands on a key other than `results:<competition>`.
7. The legacy key's entry count or hash changes at any point.

A check that contradicts one of these but was made within 60 seconds of a stage
transition is inconclusive, not a failure — cache-bust and repeat it before
acting.

## What the supervised session touches

**Will write:** `results:PL` (Step 2), and `migration:results-split` (the stage
record, on each committed stage).

**Will read:** `results`, `results:*`, `league:*`, `member:*`, `picks:*`, and
the fixture feeds.

**Will never touch:** the legacy `results` key — not written, not deleted, not
renamed. Also untouched: `user:*`, `recovery:*`, `push:*`, `custom_slate:*`,
`index:custom_mix`, `sweep:settled`, and every fixture feed.

**Not in scope for this session:** enabling the Championship. `FEATURES.elc`
stays `false` in the shipped app and `results:ELC` stays absent until the
Championship is separately green-lit.
