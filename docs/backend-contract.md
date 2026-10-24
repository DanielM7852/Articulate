# Backend contract

The audio backend owns measurement, cue choice, and session order. The visual client draws contours. The voice client speaks `feedback.spoken_text` and may replay a reference segment. Do not paste contours, evidence tables, retrieval dumps, or the coaching prompt into the voice agent.

Base URL in local development: `http://127.0.0.1:8000`. OpenAPI: `GET /openapi.json`.

## Comparison

`POST /v1/comparisons`

Multipart fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `reference_id` | yes | Id of a prepared reference. Current id: `intonation-rising-ready`. |
| `attempt_id` | yes | Idempotency key, 1–80 characters: letters, numbers, `.`, `_`, `:`, `-`. |
| `session_id` | yes | Same character rules. A newer attempt id supersedes an in-flight attempt. |
| `capture_state` | yes | Must be `learner_recording`. |
| `learner_audio` | yes | Audio file, at most 5 MB, about 0.25–12 seconds, sample rate 8–48 kHz. |

The sample rate used for pitch tracking is the rate stored in the file. Timestamps are seconds from the start of that file, including leading silence. Frames that fail voicing, range, octave, or jump checks are kept at their original time with `f0_hz` and `relative_pitch_st` set to `null` and `usable: false`.

HTTP outcomes:

- `200` with `status` of `complete`, `partial`, `insufficient_audio`, or `failed` for an analysis result.
- `404` unknown reference.
- `409` stale attempt. The body is `{status, error, message, session_id, attempt_id}`.
- `413` upload larger than the byte limit.
- `422` bad id or a capture state other than `learner_recording`.

`complete` means measurements were usable and the model output passed server checks. `partial` means measurements were usable and a deterministic cue was used because Claude was unconfigured, timed out, or returned an invalid decision. `insufficient_audio` means the take should be recorded again. `failed` means the audio or reference could not be analyzed. Unavailable numbers are JSON `null`.

`audio_retained` is `false`. `content_verified` is `false` until a content verifier is configured, and `claims_limited` is then `true`. Pitch feedback in that state does not claim the learner said the target words.

## Response shape

The result includes:

- `reference_contour` and `learner_contour`: original-time frames.
- `segments`: silence and voiced spans, plus comparison spans such as `ending`.
- `alignment` and `metrics`.
- `evidence`: ids the coaching step was allowed to cite.
- `finding`: one code from the measurement step.
- `quality_flags`.
- `feedback`: the Cartesia handoff.
- `retrieval`: `moss` or `local_fallback`. A fallback is disclosed and is not a Moss integration.
- `reasoning`: `claude` or `deterministic_fallback`.
- `timings_ms`: measured stage durations.
- `limitations`: machine-readable codes, including `voicing_probability_is_not_pronunciation_quality`.

Finding codes: `ending_direction_mismatch`, `ending_range_smaller`, `ending_range_larger`, `contour_close`, `contour_differs`, `insufficient_usable_pitch`, `capture_problem`, `alignment_failed`, `reference_unusable`.

## Cartesia handoff

`feedback` contains:

- `observation`: one short qualitative sentence. It has no measurements invented by the model.
- `instruction`: the selected cue text.
- `spoken_text`: the only string to send as the TTS transcript. For `insufficient_audio` and `failed`, this is the instruction alone.
- `cue_id`, `cue_review_status`, `next_action`.
- `reference_segment_replay`: optional `{reference_id, segment_id, start_s, end_s}`.
- `capture_limitations`: short notes. They are not part of `spoken_text`.
- `session_id` and `attempt_id`.

Example coaching bytes request, built by `app.integrations.cartesia.build_tts_request`. This backend does not send the coaching line. The same endpoint is used to speak a prepared reference when `CARTESIA_API_KEY` is set.

```json
{
  "endpoint": "https://api.cartesia.ai/tts/bytes",
  "headers": {
    "Authorization": "Bearer $CARTESIA_API_KEY",
    "Cartesia-Version": "2026-08-14",
    "Content-Type": "application/json"
  },
  "body": {
    "model_id": "sonic-3.6",
    "transcript": "The ending pitch movement does not match the reference example. At the end of the phrase, let your pitch glide up, as in the reference example.",
    "voice": "VOICE_ID",
    "output_format": {"container": "wav", "encoding": "pcm_s16le", "sample_rate": 44100},
    "language": "en"
  }
}
```

Checked against the Cartesia bytes endpoint documented with header `Cartesia-Version: 2026-08-14`. `voice` is the voice id string. Do not send both `language` and `locale`.

A voice client can fetch the handoff and speak it:

```javascript
const body = new FormData();
body.set("reference_id", "intonation-rising-ready");
body.set("attempt_id", attemptId);
body.set("session_id", sessionId);
body.set("capture_state", "learner_recording");
body.set("learner_audio", blob, "learner.wav");

const result = await fetch("http://127.0.0.1:8000/v1/comparisons", {
  method: "POST",
  body,
}).then((response) => response.json());

// Speak only result.feedback.spoken_text.
// Draw result.reference_contour and result.learner_contour elsewhere.
```

## Progress

`GET /v1/attempts/{attempt_id}/progress` is `text/event-stream`.

Stages: `received`, `analyzing_audio`, `aligning`, `comparing`, `selecting_cue`, `partial`, `complete`, `failed`.

`insufficient_audio` is a result status. Its terminal event uses stage `partial` and sets `result_status` to `insufficient_audio`. Each event has `elapsed_ms` from the start of that attempt. These events describe this backend's stages. They are not a swarm.

```javascript
const source = new EventSource(`http://127.0.0.1:8000/v1/attempts/${attemptId}/progress`);
source.addEventListener("analyzing_audio", (event) => {
  const payload = JSON.parse(event.data);
  console.log(payload.stage, payload.elapsed_ms);
});
```

## References

- `GET /v1/references`
- `GET /v1/references/{reference_id}` returns transcript, provenance, contour, and segment times.
- `GET /v1/references/{reference_id}/audio` returns the synthetic reference WAV.

Word or syllable boundaries are not available for the current reference (`word_boundaries` is null). Segment times are fractions of the measured usable span, not a forced phonetic alignment.

## Fixtures

`GET /v1/fixtures`

`POST /v1/comparisons/fixtures/{scenario}?session_id=...&attempt_id=...&reference_id=intonation-rising-ready`

Scenarios: `identical`, `baseline_shift`, `faster_speech`, `rising_vs_falling`, `silence`, `content_mismatch`.

Responses set `fixture_mode: true` and include `fixture_mode_synthetic_audio`. This is not a benchmark.

## Metric definitions

Relative pitch, per recording:

```text
relative_pitch_st = 12 * log2(F0 / median_reliable_voiced_F0)
```

Each recording uses its own median. Pitch range is not scaled to a shared range.

Usable frames are voiced, have voicing probability at least 0.5, lie between 70 and 500 Hz, are not a local octave jump within 1.25 semitones of 12, 24, or another octave, and are not an adjacent jump above 8 semitones inside 80 ms. Those cutoffs are engineering defaults in `app/config.py`.

Coverage is the fraction of frames inside the first-to-last usable span that remain usable. It ignores silence before and after the phrase.

Ending change is the median relative pitch of the last 20% of the usable span minus the median of the 20% before that. Direction is `rising` above +1.5 semitones, `falling` below -1.5, otherwise `steady`. A single frame is not an endpoint.

Pitch range is the 90th percentile minus the 10th percentile of usable relative pitch.

Movement time is the fraction of the usable span, in the second half, where the contour crosses halfway from the body to the ending median. It stays on the original clock.

Duration ratio is learner usable-span duration divided by the reference span. It is reported even when shape is compared on normalized time.

Aligned RMSE is the root mean square relative-pitch difference. When duration ratio is within 1.15, the contours are linearly resampled on each recording's own time base. Constrained DTW (`librosa.sequence.dtw`, Sakoe-Chiba band) is used only when the duration ratio is outside that trigger and the length difference fits inside a band of at most 0.45. A wider difference is not warped away; linear normalization is used and the duration ratio remains in the result. Ending metrics never use the warped clock.

pYIN voicing probability is a detector output. It is not a pronunciation score. F0 does not support tongue, lip, or jaw claims.

## Content check

`app.audio.content.ContentVerifier` is the hook. The default returns `content_verified=false` and `content_verifier_not_configured`. A future recognizer can replace that class. Until then, coaching text must not claim the expected words were said.

## Storage

`SessionStore` is the persistence interface. `LocalSessionStore` writes JSON under `STORE_DIR`. It stores attempt summaries and derived results, not audio bytes. Convex is not wired. Do not add a second database alongside this interface until the team chooses one.

`DELETE /v1/sessions/{session_id}` removes the JSON record and in-memory progress for saved attempts.

Reusing an attempt id returns the first saved result and does not analyze a new recording. Use a new attempt id for a new take.
