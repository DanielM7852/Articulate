# Synthetic inputs

`app.features.synthetic_frame(target_id, index)` supplies deterministic 40 ms frames at 24000 Hz sample-relative offsets for `/i/`, `/u/`, `/ɑ/`. The web fixture mode, tests and benchmark consume it. Values oscillate around demonstration regions; they are generated numbers, not speech measurements, and carry `source: synthetic`.

Mock audio is an independent 330 Hz diagnostic tone, not a vowel example. The browser silence test supplies a synthetic silent MediaStream to the real capture worklet. No video or clinically reviewed target recordings are bundled; the only recordings are the sample voices below.

## Sample voices

`voices/` holds ten short speech recordings (WAV). They are used offline to check the phone model (`services/phones/scripts/build_word_timing.py` reads them by default) and are not loaded by the app.
