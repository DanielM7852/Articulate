# Version 1 session and PCM protocol

JSON server events use `schema_version`, `type`, `session_id`, nullable `attempt_id`/`generation_id`, UUID `event_id`, monotonic integer `seq`, and `payload`. A connection first receives a `snapshot` wrapper with state, sequence, compact history and pending sync. Disconnect recovery uses that snapshot; obsolete audio is never replayed.

Commands contain `schema_version:1`, UUID `command_id`, integer `expected_revision` and discriminated `payload`. Types: `session.configure`, `attempt.start`, `attempt.end`, `feedback.cancel`, `session.pause`, `session.resume`, `audio.playback_started`, `audio.playback_ended`. See [canonical schema](../packages/contracts/schema.json). Configure supplies target/audio/assistance; start supplies source and actual AudioContext rate; end supplies final microphone sample count (zero for fixtures). Playback acknowledgements carry generation UUID. Revision conflicts require a fresh snapshot and new command ID; retrying an acknowledged ID does not repeat it.

States: ready → capturing → analyzing → coaching → presenting → ready. Pause works from active states; resume returns to ready. Start/configure/cancel interrupts obsolete work. Invalid/incomplete capture yields `repair_capture`. Feature processing never waits for LLM/TTS/outbox network calls. Playback is cleared before recording; stale upload IDs and frame order are rejected.

On `/audio`, authenticate with `{"capability":"..."}`, then send `{"encoding":"pcm_s16le","channels":1}`. Wait for `audio.ready`. One audio transport is allowed per session. Upload rate is the actual AudioContext rate (8000–96000 Hz), selected per attempt. Synthetic fixtures use 24000 Hz. Playback is mono signed 16-bit little-endian PCM at 24000 Hz.

Binary frames: 44-byte little-endian header, then exactly `sample_count * 2` bytes:

| Offset | Bytes | Meaning |
|---|---:|---|
| 0 | 4 | ASCII `VSC1` |
| 4 | 1 | direction: 1 microphone upload, 2 coach playback |
| 5 | 1 | channels: 1 |
| 6 | 1 | encoding: 1 = pcm_s16le |
| 7 | 1 | reserved: 0 |
| 8 | 16 | UUID in canonical byte order: attempt ID on upload, generation ID on playback |
| 24 | 4 | uint32 sequence, starts at zero |
| 28 | 8 | uint64 sample offset, starts at zero |
| 36 | 4 | uint32 sample rate |
| 40 | 4 | uint32 sample count |

Maximum frame: 9600 samples; upload frames also cannot exceed 200 ms. Browser uploads 40 ms chunks. Sequences/offsets must be contiguous. Attempts are limited to 30 seconds. The analysis queue holds eight frames; overflow closes transport rather than silently scoring dropped audio. Event queues hold 128 messages; audio queues hold 64. Slow consumers disconnect. Deployment limits WebSocket messages to 64 KiB and network receive queue to eight.

`audio.start` on the audio socket precedes binary frames and includes generation, rate and startup buffer. `audio.end` means synthesis/network output finished; the browser still drains its worklet. `audio.cancelled` clears it. These transport controls accompany full-envelope events on the events socket. Word/phoneme `audio.timings` offsets are seconds relative to generation start. Missing timing uses a static reference; timestamps are not anatomical evidence.

The worklet starts after the default 80 ms threshold, or drains a shorter final clip after end. Its two-second source-rate ring linearly resamples to the output device rate. Overflow stops playback; underruns insert silence and rebuffer without replay. Playback start is recorded when the worklet consumes its first samples, not on receipt. Captions display immediately on accepted decision. Browser intervals use `performance.now()`; server stages use `perf_counter()`.

Reconnect clears media and fetches state. Restart restores durable session metadata and summaries, cancels active work and issues a new revision. The local journal replays durable events committed immediately before a snapshot-write crash. Database retry uses stable event IDs and confirmed HTTP calls; a missing local spool is not rebuilt from remote state in this MVP.
