# Track A review and verification

Reviewed the working diff with the code-reviewer checklist: pipeline equivalence, reference alignment, acceptance/error denominators, missing measurements, source licence/provenance, bounded filesystem/network behavior, default-off UI state, keyboard operation, small-screen layout and microphone lifecycle.

One correctness issue was found during review: interpolating an absent F3 reference could invent a value. A new test failed with actual 1350 versus expected 0; the fix propagates the missing marker and excludes that F3 pair. The diagnostic was rerun. No runtime audio code changed.

Verification on the final code:

- `npm test`: 42 passed + 2 expected fail (44), five files. The two noisy-oo F1 slip cases remain known failures; they were not converted to passing claims.
- `npm run build`: typecheck and Vite production build pass; scripts are included in typechecking.
- `MAPPER_PORT=5181 npm run test:e2e`: 7 passed.
- `MAPPER_PREVIEW=1 MAPPER_PORT=5182 npm run test:e2e -- --grep 'synthetic microphone|consonant cue prototype'`: 2 passed.
- Real-speech browser script: four fixtures accepted positions, Finish retained traces, no page errors; desktop and 320px screenshots inspected.
- Full offline study: 335 clips at five noise conditions. Mask removal, each separate clean-mask ablation, and naive clean F3 analysis completed. Final repeat compared against baseline separately.
- `git diff --check`: pass. Python scripts compile. No audio or downloaded corpus metadata files are committed; the committed provenance contains only dataset IDs, counts and checksums.

The cue prototype test was red before implementation (missing checkbox), then green. The evaluation boundary/interpolation/noise tests were red before the core module existed, then green. There is no regression test claiming a nasal or noisy-vowel fix because no such fix ships.

Limitations are substantive: no human live-mic test, no Safari verification, no venue recording, no learned detector, no production nasal rejection, no separately explicit original H95 audio licence, and no independently labelled r/w F3. Default behavior retains consonant leakage and the existing low-SNR gaps. See the decision report for the measured trade-offs.
