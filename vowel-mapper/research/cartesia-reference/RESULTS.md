# Cartesia as the reference voice (2026-10-24)

Question: can a Cartesia voice (sonic-3.6, teammates' default voice db6b0ed5…) serve as the measured
"native speaker" reference, sized to each learner by the voice multiplier?

Clips: `/Users/Git/Articulate-overnight/data/cartesia-ref` (5 words × speed 0.7/0.85/1.0) and
`/Users/Git/Articulate-overnight/data/cartesia-stretched` (drawn-out spellings). Analysis:
`voice-targets/vowel-mapper/scripts/eval/reference-voice.ts` (production estimator + tracker; checked on
synthetic vowels: factor −0.097 vs true −0.105).

Findings
- Plain words are ~0.7–1 s with short vowels. Through the tracker, 13 of 15 clips gave fewer than the 12 points
  a hold needs; no voice factor could be set. The speed setting barely changed clip length.
- Raw estimator frames (no tracker) gave values, but one voice is noisy: "had" very open, "heard" F2 ≈ 1,980 Hz.
  Factor ≈ +0.10; Cartesia ee ≈ 2.0 and ah ≈ 1.2 reference radii from the 139-speaker reference.
- Drawn-out spellings were unreliable: "eeeeeeee" gave a clean 1.2 s /i/ (322/2905 Hz, 34 frames);
  "ahhhhhhh" gave 0.56 s of a non-/ɑ/ sound; others 1–14 frames, and the two spellings of a word disagreed.

Conclusion: Cartesia does not reliably produce held vowels, so it is not yet a dependable measured target.
Use it to speak the model word and the coaching; keep the plotted target from the multi-speaker reference
(or a real person holding vowels — same script, same math).
