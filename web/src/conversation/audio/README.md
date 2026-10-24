# Conversation audio

Hands-free audio layer: `useConversationAudio({ vowel, enabled, deviceId })` returns a `ConversationAudio` (see `types.ts`).

- `segmenter.ts` pure state machine on vowel-tracker frames (rms, periodicity, F1/F2), `performance.now()` clock.
  Onset: 3 consecutive frames with rms > noise floor + 10 dB (min 0.008) and periodicity >= 0.5. End: 700 ms below threshold. Min 350 ms (shorter is discarded; `onSegmentStart` has already fired, no segment follows). Max 8 s forced end. 300 ms hold-off after the teacher stops.
  `attempt` iff voicedFraction >= 0.6 and formantStability >= 0.5 (stability = 1 - max(sd ln F1 / 0.12, sd ln F2 / 0.10), clamped); else `reply`.
- `inkStt.ts` Cartesia Ink client (`model` default `ink-whisper`; `ink-2` adds keyterm hints again/ready/skip/show me/why). Token via `POST /v1/speech/token`, cached until 30 s before expiry, never logged. Audio streams only during a segment (not in `attempt`-only listen mode, and aborted if the segment classifies as an attempt). 300 ms pre-roll from the AEC track, 16 kHz s16le via a streaming box-filter resampler, ~100 ms frames, `finalize` at segment end, wait up to 1.5 s for `flush_done`. Failure gives `transcript: null`, `sttError` set. A socket is prewarmed (max 10 s old) when listening for replies.
- `micAec.ts` second getUserMedia track: `echoCancellation: "all"` (fallback `true`), noiseSuppression and autoGainControl on. The raw formant track is separate.
- `bargeIn.ts` fires once per teacher utterance. Modes (persisted in localStorage `articulate.bargein`, default `gated`):
  - `gated` (AEC track): calibrate the echo residual over 300 ms after echo appears; threshold = max(floor + 10 dB, sqrt(echo^2 + floor^2) + 8 dB); needs periodicity >= 0.5; holds 150 ms (~3 frames of 50 ms, 60 ms gap tolerance). Cannot fire during calibration. Optional `setTeacherLevel(rms)` makes the echo estimate follow TTS output level.
  - `aec` AEC track, plain VAD (floor + 10 dB, voicing). `headphones` raw track, plain VAD. `off` never.
  - Measured basis (Chrome 155, laptop speakers): AEC floor -48 dBFS, TTS residual -38, loud speech -15 (about 22 dB over echo); Chrome AEC removes only about 8 dB of Web Audio TTS.
- Director usage: call `setTeacherSpeaking(true/false)` around TTS, `listen(mode)` when expecting the learner; on `onBargeIn` cancel the TTS and call `setTeacherSpeaking(false)`.
