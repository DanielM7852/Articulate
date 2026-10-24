# Live metrics and learner history (SpacetimeDB)

Module: `spacetimedb/src/index.ts`. All tables are `public: false`.

## Tables

| Table | Columns |
|---|---|
| `learner` | `identity` Identity PK, `profile_id` string (index), `display_name`, `created_at`, `updated_at` |
| `learner_attempt` | `attempt_id` string PK, `learner` Identity (index), `profile_id` (index), `sound`, `status` (`open`/`ended`/`coached`), `started_at`, `ended_at` Option<Timestamp>, `summary` ('' until backend writes JSON) |
| `metric_batch` | `id` u64 PK autoInc, `attempt_id` (index), `kind` (`audio`/`video`), `seq` u32, `frame_count` u32, `frames` (JSON array text), `received_at` |
| `coach_turn` | `attempt_id` PK, `profile_id` (index), `created_at`, `decision` (JSON) |
| `learner_note` | `profile_id` PK, `notes` (JSON), `updated_at` |

## Client reducers (any identity)

Argument order below is the positional order for HTTP `POST /v1/database/{db}/call/{reducer}` (JSON array body).

- `register_learner(profile_id, display_name)`: upserts the row for the caller. `profile_id` 1-64 chars of `[A-Za-z0-9_.:@-]`; `display_name` at most 80 chars.
- `begin_attempt(attempt_id, sound)`: caller must be registered. `attempt_id` a UUID; `sound` 1-16 chars `[a-z]`. Status starts `open`; `profile_id` copied from the learner.
- `push_metrics(attempt_id, kind, seq, frames_json)`: caller must own an `open` attempt. `kind` is `audio` or `video`. `frames_json` at most 32768 bytes (UTF-8), a JSON array of 1-200 objects. A repeated `(attempt_id, kind, seq)` is a silent no-op (safe retry).
- `end_attempt(attempt_id)`: owner only; sets `ended_at` and status `ended`. No-op if already `ended`/`coached`.

## Backend-only reducers (the `backend` identity stored by `init`)

- `record_coach_turn(attempt_id, summary_json, decision_json)`: attempt must exist; each argument a JSON object of at most 16384 bytes. Sets `learner_attempt.summary`, status `coached`, and inserts or replaces the `coach_turn` row.
- `set_learner_note(profile_id, notes_json)`: JSON object at most 16384 bytes; upsert. `profile_id` validated as above.

## Error messages

`backend only`, `not a registered learner`, `attempt_id must be a UUID`, `invalid sound: ...`, `attempt already exists`, `unknown attempt`, `not attempt owner`, `attempt is not open`, `kind must be audio or video`, `frames too large`, `frames_json is not valid JSON`, `frames_json must be a JSON array of 1-200 frames`, `each frame must be a JSON object`, `invalid profile_id...`, `display_name too long (max 80)`, `<arg> too large`, `<arg> is not valid JSON`, `<arg> must be a JSON object`.

## Backend reads

`POST /v1/database/{db}/sql` with the owner (backend) token; the body is the SQL text. Private tables are not readable by other identities (assumption: standard SpacetimeDB owner-only SQL on private tables).

```sql
SELECT * FROM metric_batch WHERE attempt_id = '<uuid>'
SELECT * FROM learner_attempt WHERE profile_id = '<p>'
SELECT * FROM learner_note WHERE profile_id = '<p>'
SELECT * FROM coach_turn WHERE profile_id = '<p>'
```

`metric_batch` rows have no guaranteed order; sort by `kind`, `seq` client-side.

## Verification and assumptions

Verified by `npm run test:database` (module test harness): all reducers above, ownership and backend checks, idempotent push. Not verified: HTTP call/SQL wire formats and Maincloud behaviour (assumptions). Option columns are written as `undefined` for None in TypeScript; over SQL a None `ended_at` appears as the SDK's option encoding. Frames are stored as text, so an attempt's data volume is bounded only by client push rate; no retention or per-attempt cap is implemented.
