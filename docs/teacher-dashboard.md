# Teacher dashboard

The classroom lives on the primary learner app (`web/`), the FastAPI service (`backend/`), and the SpacetimeDB module in `spacetimedb/`. That is the same module the live practice client already uses. It is not the separate coaching app in `apps/web`, and it does not replace the existing `articulate-dev` database.

SpacetimeDB 2.13.0 is the CLI, the local server, the module package, and the generated TypeScript bindings in `web/src/module_bindings`.

## What the teacher can change

A lesson is a bounded JSON object: target `i`, `u`, `a`, or `head`; context `sound`, `word`, or `phrase`; cue `spread-lips`, `round-lips`, `open-jaw`, or none; assistance `cue-target`, `target-only`, or `none`; reference replay on or off; 1 to 8 repetitions; and a note of at most 160 characters. There is no field for script, a model prompt, or an analysis threshold.

Precedence is learner override, then classroom assignment, then the default plan (target `i`, isolated sound). Revoking writes a new revision. It does not edit the old one. A learner override stays in front of a later classroom assignment until it expires or is revoked.

Expiration is checked when a learner reducer runs, including the 5 second presence heartbeat. The view reads that stored result.

"Needs attention" is an engineering rule: 3 recent usable attempts with the same verified performance finding and the same reference version. Capture problems, provisional client metrics, and synthetic fixtures do not count. Pitch is stored separately from vowel cues. F0 is not a vowel score and not a tongue or lip position.

## Identity

A display name is not authority. Where the classroom database runs beside the backend (localhost, or the `deploy/teach` container) the backend holds the publisher token in `backend/.local_store/classroom_owner.json` (gitignored) and mints a one-time invite. The browser accepts that invite with its own identity. The same development name returns the same token, so two browsers for one learner share the profile. Teacher and learner are different identities. A public reducer cannot grant teacher. Students cannot read the classroom board or another learner's attempts. Only the publisher identity can write a verified or synthetic summary.

This is a development login. Production still needs a real account system that maps a signed-in person to one Spacetime identity, and the publisher token must stay on the server.

### Virtual learners

Nobody logs in or joins anything in the learner app. When a learner taps **Begin** (or reloads past the landing page without a session), `web/src/classroom/autoJoin.ts` quietly asks `/v1/dev/classroom/session` for a learner in the default classroom and keeps that session in the tab (`auto: true`). It never blocks Begin and never shows an error; if the backend is unreachable it tries once more after 10 seconds, then gives up for that page load and the app runs without the classroom.

- A virtual learner is a device, not a person. Its name is the optional name typed on the landing page (lowercased, `[a-z0-9-]`, accents and other characters dropped) plus a 4-character device suffix kept in `localStorage` (`articulate.deviceId`), for example `lea-k3f9`, or `learner-k3f9` with no name. The whole name stays within 24 characters. The same device gets the same profile in every tab; two devices that type the same name get different profiles. Clearing site data makes a new device.
- The name is display only. It grants nothing: the route only mints the role it is asked for, a learner identity cannot call teacher reducers, and nothing turns a learner into a teacher. The development route still mints a teacher identity for anyone who asks for `role: teacher` on a host where it is enabled; that is the existing development login, not something the virtual learner adds.
- The default classroom is `VITE_CLASSROOM_DEFAULT` in `web/.env` (falls back to `room-1`).
- A virtual learner keeps the usual onboarding (greeting, survey, tutorial). The classroom flow (the teacher greeting, straight to practice, no survey) applies to an explicit class join, or once a teacher has assigned that learner a lesson (a learner override or a classroom assignment, not the default plan). `LessonSync` records that per profile when the lesson arrives.
- The route's guard is where the database lives, not who calls: it serves any caller when the owner URI in `classroom_owner.json` is `127.0.0.1` or `localhost`, and refuses (404) when the owner points anywhere else, such as Maincloud. That covers local development and the deployed teaching console (`deploy/teach`), whose database runs on `127.0.0.1` in the same container while nginx proxies `/v1/dev/` from the public host.

## Run it locally

The local server is already expected on `127.0.0.1:3000`. The classroom database is `articulate-classroom`. Do not publish this module onto `articulate-dev` or `articulate-local`, and do not pass `--delete-data`.

```powershell
# from the repo root, only if that database does not exist yet
.tools\spacetime\spacetimedb-cli.exe publish articulate-classroom --server local --module-path spacetimedb --yes=skip-login

# backend, from backend\
..\.venv\Scripts\python -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

# learner app and teacher app, from web\
npm run dev
```

Open two windows:

1. Learner: <http://127.0.0.1:5173/>. Optionally type `lea` in "What should Ava call you?", then **Begin**. A virtual learner such as `lea-k3f9` joins the default classroom (`VITE_CLASSROOM_DEFAULT`, else `room-1`) in the background; there is no join step.
2. Teacher: <http://127.0.0.1:5173/teach.html>. Name `ada`, classroom `room-1`, then **Open dashboard**.

The teacher board lists `lea-k3f9` (the suffix is this browser's device id) with presence, exercise, revision, usable and unusable counts, the latest finding, and acknowledgment. Select that learner, set the target and context, choose **Preview visible change**, then **Save lesson**. The learner shows "Lesson updated by your teacher" and the new target. The board moves from pending to applied. Refreshing either window keeps that revision. Another browser (another device suffix) is an independent learner in the same classroom. A learner in a different classroom is not on this board.

Practice audio still goes to the existing comparison service. A verified head comparison is written only when the learner's classroom profile id is sent to `/v1/word-match`. The dashboard subscribes to the compact board, and loads attempt cards only for the selected learner. Raw recordings are not in the subscription.

## Tests and the synthetic classroom

```powershell
node --experimental-strip-types web/src/classroom/applyLesson.test.ts
node --experimental-strip-types spacetimedb/src/lessonRules.test.ts
backend\.venv\Scripts\python -m pytest backend/tests/test_classroom_auth.py
cd web
node scripts/run-classroom-sim.mjs
```

The auth test calls reducers and views with a stranger token. On this server a rejected reducer is HTTP 530 with a generic body; the module log has the specific text (`backend only`, `revision conflict`, `superseded`). The test checks that the stored lesson did not change.

The simulator uses the real reducers and subscriptions, separate synthetic identities, and `performance.now()` in one Node process. It does not call Claude or record audio. Observed on this machine:

| Learners | Samples | Save to learner cache p50 / p95 | Save to applied ack p50 / p95 | Summary to teacher p50 / p95 | Noisy overlap |
| --- | --- | --- | --- | --- | --- |
| 2 | 6 | 3 ms / 6 ms | 3 ms / 4 ms | 22 ms / 37 ms | 55 ms, 0 errors |
| 10 | 6 | 3 ms / 9 ms | 3 ms / 7 ms | 5 ms / 32 ms | 76 ms, 0 errors |
| 30 | 4 | 4 ms / 7 ms | 5 ms / 6 ms | 6 ms / 35 ms | 101 ms, 0 errors |

The lesson reducer body was 254 bytes. A classroom assignment reached the other members of that room. Another teacher's board did not. Forty presence calls from one learner overlapped a save to another learner and did not produce a reducer error. Summary timing can include one 20 ms poll. These are local transport numbers, not a capacity limit for a hosted classroom.

## Maincloud, not deployed

Publish a new database name. Do not point this at an existing production database, and do not use `--delete-data`.

```powershell
.tools\spacetime\spacetimedb-cli.exe publish articulate-classroom --server maincloud --module-path spacetimedb --yes=skip-login
```

Put that database's publisher token only in the server environment, not in the browser. The development routes stay off for this database: they refuse an owner URI that is not `127.0.0.1` or `localhost`, so virtual learners are not minted against Maincloud. Generate bindings with `spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb`. Then run the auth test against that database before sending teachers to it.

## Limits

- One teacher identity per classroom in this version.
- The development invite route works only when the classroom database runs beside the backend (owner URI on `127.0.0.1` or `localhost`): local development and `deploy/teach`.
- An acknowledgment means the lesson was received or applied, not that the learner understood it.
- A lesson that arrives during recording waits until the take ends. The attempt keeps the revision it started with.
- Reconnect shows the current lesson again and does not speak it.
- Client practice reports are provisional. Synthetic seeds are labeled and do not add to usable progress.
