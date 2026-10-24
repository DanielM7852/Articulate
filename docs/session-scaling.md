# Shared practice sessions and deployment

The `web/` + `backend/` practice application can run multiple API and worker
replicas against one SpacetimeDB module. Set `LIVE_COORDINATION=spacetime` to opt
in. `local` is the default and retains the synchronous demo behavior.

This change applies to `/v1/live/*`. The separate `services/api` backbone remains
an independent demo with local SQLite recovery and its existing deployment files.
Legacy comparison/session-file endpoints and `/v1/coach` are disabled in shared
mode; they do not acquire shared ownership merely by adding API replicas.

## Request and worker lifecycle

1. `GET /v1/live/identity` establishes a random browser/device profile with an
   HttpOnly, SameSite=Strict signed cookie. API replicas share its signing secret.
   The browser replaces display-name profile IDs at the live API boundary.
2. Live POSTs authenticate that cookie and reject other profiles. They enqueue a
   private `live_job` through `enqueue_live_job` and return HTTP 202 with `jobId`
   and `statusUrl`. `Idempotency-Key` must be a UUID for repeatable conversation
   and notes requests; attempt coaching always uses the attempt UUID as its key.
   Reusing a key with a different request returns 409. Retries replay the original
   result while its job row remains within the configured retention period.
3. The browser polls `GET /v1/live/jobs/{job_id}`. A different API replica can serve
   every request. Only the job owner can poll; responses use `Cache-Control: no-store`.
4. Independent `python -m app.live.worker` processes poll bounded status-indexed
   batches. A reducer atomically claims each job with a random lease token.
   Heartbeats renew the lease; expired work can be reclaimed up to three times.
5. Workers run the existing scoring, Claude and validation logic. History writes
   are staged in memory. A single completion reducer checks the current lease and
   session revision, then commits state, history and the response atomically.
   Stale workers cannot publish results or history. External provider requests
   are **at least once** after a crash; this does not promise exactly-once billing.
6. Conversation responses carry a `revision`. Turns must supply `expectedRevision`;
   concurrent turns cannot overwrite each other. On 409, the caller should poll
   its outstanding job or start a fresh session rather than silently rebasing an
   old command onto a newer conversation.

Sessions live in private `live_session` rows, rather than the process-local
500-entry dictionary. A per-session claim serializes mutations. There is no
sticky-session requirement for these HTTP endpoints. Graceful worker shutdown
cancels local work; its uncompleted lease can be reclaimed by another worker.

## Ownership and media

The signed cookie authenticates possession of a browser profile; it is **not an
account login**, cross-device recovery or an organization membership system.
The existing mock sign-in screen still is not account authentication. Real account
rollout needs verified OIDC/account identities mapped to stable profile IDs.
Rotate the signing secret only with an explicit identity-migration plan: existing
guest cookies become invalid. Deploy the frontend and API under the same origin.
Keep `LIVE_COOKIE_SECURE=true` behind HTTPS; use `false` only for local HTTP.

The `p_<32 hex digits>` profile namespace is reserved by the database module, so
direct browser clients cannot register themselves as API-managed learners. All
coordination tables and reducers remain backend-only; no owner token enters the
browser. Speech token endpoints require the same cookie in shared mode.

Shared mode sends capped, derived acoustic/lip features in the authenticated
attempt request. The API queues them in SpacetimeDB; the browser's anonymous SDK
metric sink is disabled in this mode. Raw microphone samples, camera video, and
Cartesia output are not routed through the database. Existing browser-to-Cartesia
streaming remains in use. This branch does not introduce media event tables,
new Moss retrieval, or speculative speech generation.

On completion/failure, request features are cleared from the job row. Workers
periodically select bounded expired job/session IDs through expiry indexes and
recheck expiry and leases in a cleanup reducer. Completed job responses remain
for `LIVE_JOB_RETENTION_S`; summaries/progress remain in learner-history tables.
These are logical retention rules: inserts and deletions can remain in the
database commit log/backups. Legacy `metric_batch` rows are unaffected.

## Deployment

1. Review/build/test the module, then publish `spacetimedb/` to your selected
   Maincloud database using the normal approval/deployment process. Schema changes
   are additive; existing live-metrics and backbone tables/reducers are retained.
   Do not enable shared mode before the new tables/reducers exist.
2. Copy `backend/.env.example` and `backend/.env.secrets.example` to their local
   configuration files. Set `SPACETIME_DATABASE`, the server-side `SPACETIME_TOKEN`,
   provider keys, and a random `LIVE_IDENTITY_SECRET` of at least 32 characters.
   Every replica in the deployment must receive the same settings/secret.
3. Use the new practice deployment (the original `deploy/compose.yaml` runs the
   separate backbone):

   ```sh
   docker compose -f deploy/compose.practice.yaml up --build \
     --scale practice-api=2 --scale practice-worker=2
   ```

   It serves the practice app on `127.0.0.1:8080`, load-balances API replicas,
   and runs separate worker containers. For local HTTP explicitly set
   `LIVE_COOKIE_SECURE=false` in `backend/.env`. For production put HTTPS in
   front, keep secure cookies, and configure your allowed frontend origin.
   Inject secrets through the hosting platform rather than baking env files into
   images. The Docker build context excludes nested env files and local stores.

Without Docker, run multiple `uvicorn app.main:app` processes behind a load
balancer and separate `python -m app.live.worker` processes from `backend/`.
Maincloud hosts the TypeScript database module; it does not execute this Python
application. API and workers can be scaled independently on a container host.

`/health/live` checks API process liveness. `/health/ready` verifies access to both
coordination tables in shared mode; it does not prove a worker is running or a
provider has quota. Keep workers supervised and alert on queued age and failures.

## Capacity controls and rollout

| Setting | Default | Scope |
| --- | --- | --- |
| `LIVE_WORKER_CONCURRENCY` | 4 | Jobs per worker process |
| `LIVE_GLOBAL_CONCURRENCY` | 32 | Running jobs across workers on this database |
| `LIVE_QUEUE_LIMIT` | 1000 | Queued plus running jobs on this database |
| `LIVE_JOBS_PER_PROFILE` | 4 | Queued plus running jobs per browser profile |
| `LIVE_JOB_LEASE_S` | 60 | Lease, renewed every one-third of its duration |
| `LIVE_JOB_POLL_S` | 0.2 | Worker polling interval |
| `LIVE_JOB_RETENTION_S` | 3600 | Job replay window and abandoned request lifetime |
| `LIVE_SESSION_TTL_S` | 3600 | Conversation idle lifetime, capped at one day on completion |

Configure all workers with the same global limits. Running-job limits bound
concurrent job executions, not provider requests still running after a network
timeout. Configure provider quotas, gateway rate limits and spend limits for an
internet-facing rollout; guest issuance alone is not abuse prevention. CPU-heavy
audio analysis belongs in independently bounded processes if added to this live
feature-based path. Cartesia's direct-browser sessions have their own quota.

Start with one database. Load-test concurrent sessions, attempt completion bursts,
worker termination, DB disconnects and provider timeouts. Measure queue age,
claim-to-result latency, first audible feedback, reducer latency, bandwidth, and
provider throttling. This branch does not claim a tested user capacity.

When a measured database bottleneck justifies partitioning, assign learners or
organizations to a stable database shard and route API/worker traffic accordingly.
Do not hash every request independently or scatter one learner's history between
session databases. Automatic sharding, shard migration, object-storage audio
caches and production account provisioning are not implemented here.

The initial Python adapter uses pooled HTTP SQL/reducer calls, and browsers poll
for completed jobs. SpacetimeDB documents its HTTP API as less optimized than
the SDK's WebSocket transport. Include this overhead in load tests; a typed SDK
subscription gateway is a follow-up if polling becomes a bottleneck. See the
[HTTP API](https://spacetimedb.com/docs/http/database/) and
[Maincloud deployment](https://spacetimedb.com/docs/how-to/deploy/maincloud/).

## Verification

From the repository root, run `npm run test:database`, `npm run test:practice`,
and `npm --prefix web run build`. From `backend/`, run `python -m pytest -q`.
The database tests use SpacetimeDB's real WASM datastore harness for atomic
claims, lease takeover, stale completions, quotas, expiry and revision conflicts.
The API/worker tests use an HTTP fake to verify independent-replica round trips.

During development, the module was also built with the SpacetimeDB 2.13.0 CLI
and published to an isolated localhost standalone server. Provider-free checks
exercised two API instances, a replacement worker, conversation revision recovery,
attempt scoring/history commits, notes updates and cleanup SQL against that real
server. Maincloud and the Docker images were not deployed or exercised.
