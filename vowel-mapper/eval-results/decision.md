# Real-speech evaluation decision

No production estimator, tracking threshold, or nasal gate changed. The offline study found substantial consonant leakage, and the candidate nasal rule did not meet the development criterion. The opt-in UI is a scripted representation preview only.

## Held-out baseline (and unchanged runtime after this work)

All percentages below use eligible full-window frames as denominator. These are descriptive frame-weighted results from small speaker samples, not independent-frame statistical confidence estimates.

| Source | Noise dB | Group | Eligible frames | Tracked acceptance | Median absolute F1 / F2 error Hz |
|---|---|---|---:|---:|---:|
| H95 exploratory | clean | vowel | 1505 | 77.2% | 19.2 / 41.7 |
| H95 exploratory | 20 | vowel | 1505 | 79.3% | 18.3 / 43.1 |
| H95 exploratory | 15 | vowel | 1505 | 78.0% | 18.1 / 43.9 |
| H95 exploratory | 10 | vowel | 1505 | 74.2% | 18.1 / 47.4 |
| H95 exploratory | 5 | vowel | 1505 | 59.5% | 20.6 / 57.8 |
| LibriSpeech | clean | vowel | 1291 | 52.2% | — / — |
| LibriSpeech | clean | nasal | 256 | 34.4% | — / — |
| LibriSpeech | clean | voiced-fricative | 164 | 11.0% | — / — |
| LibriSpeech | clean | unvoiced-fricative | 393 | 2.0% | — / — |
| LibriSpeech | clean | stop | 437 | 5.7% | — / — |
| LibriSpeech | clean | glide-liquid | 329 | 48.6% | — / — |
| LibriSpeech | 20 | vowel | 1291 | 50.4% | — / — |
| LibriSpeech | 20 | nasal | 256 | 27.3% | — / — |
| LibriSpeech | 20 | voiced-fricative | 164 | 10.4% | — / — |
| LibriSpeech | 20 | unvoiced-fricative | 393 | 2.0% | — / — |
| LibriSpeech | 20 | stop | 437 | 2.5% | — / — |
| LibriSpeech | 20 | glide-liquid | 329 | 38.3% | — / — |
| LibriSpeech | 15 | vowel | 1291 | 47.9% | — / — |
| LibriSpeech | 15 | nasal | 256 | 23.0% | — / — |
| LibriSpeech | 15 | voiced-fricative | 164 | 6.7% | — / — |
| LibriSpeech | 15 | unvoiced-fricative | 393 | 2.0% | — / — |
| LibriSpeech | 15 | stop | 437 | 2.5% | — / — |
| LibriSpeech | 15 | glide-liquid | 329 | 33.7% | — / — |
| LibriSpeech | 10 | vowel | 1291 | 39.4% | — / — |
| LibriSpeech | 10 | nasal | 256 | 16.8% | — / — |
| LibriSpeech | 10 | voiced-fricative | 164 | 6.1% | — / — |
| LibriSpeech | 10 | unvoiced-fricative | 393 | 1.8% | — / — |
| LibriSpeech | 10 | stop | 437 | 1.8% | — / — |
| LibriSpeech | 10 | glide-liquid | 329 | 24.0% | — / — |
| LibriSpeech | 5 | vowel | 1291 | 28.3% | — / — |
| LibriSpeech | 5 | nasal | 256 | 10.2% | — / — |
| LibriSpeech | 5 | voiced-fricative | 164 | 3.7% | — / — |
| LibriSpeech | 5 | unvoiced-fricative | 393 | 1.5% | — / — |
| LibriSpeech | 5 | stop | 437 | 1.6% | — / — |
| LibriSpeech | 5 | glide-liquid | 329 | 15.2% | — / — |

Hillenbrand is supplementary/exploratory because the authorised mirror has a repository MIT licence, but the original audio has no separately stated licence in the archived readme. LibriSpeech and DEMAND have explicit corpus licences. Error cells are conditional on acceptance and measurable reference values; LibriSpeech has no F1/F2 truth. Rejection can lower apparent error by excluding difficult frames.

## Nasal rejection experiment — not shipped

The development screen required at least 70% removal of already accepted nasal frames and at most 5% removal of already accepted vowel frames. None of 294 combinations met both. The held-out table reports the development-selected maximum nasal removal among rules within the vowel-loss budget; held-out values did not select the rule. This is an optimistic post-tracker analysis, not a deployed detector or a full rerun of tracker acquisition under a gate.

Selected diagnostic rule: low/mid > 5 dB, low/high > 25 dB, level relative to loudest voiced frame in 3 s ≤ 0 dB. Thresholds and budget are provisional engineering screening choices, not speech-science constants.

| Split | Phone group | Baseline accepted | Removed by candidate | Removed fraction |
|---|---|---:|---:|---:|
| development | vowel | 816 | 24 | 2.9% |
| development | nasal | 144 | 73 | 50.7% |
| development | voiced-fricative | 31 | 7 | 22.6% |
| development | unvoiced-fricative | 7 | 2 | 28.6% |
| development | stop | 32 | 4 | 12.5% |
| development | glide-liquid | 160 | 20 | 12.5% |
| heldout | vowel | 674 | 37 | 5.5% |
| heldout | nasal | 88 | 49 | 55.7% |
| heldout | voiced-fricative | 18 | 5 | 27.8% |
| heldout | unvoiced-fricative | 8 | 1 | 12.5% |
| heldout | stop | 25 | 14 | 56.0% |
| heldout | glide-liquid | 160 | 30 | 18.8% |

The band cues overlap: quiet/back vowels can be removed and many nasals survive. Loudness alone is also confounded by ordinary vowel level variation. No consonant-identification claim is justified. The r/w/l/y group has acoustic transitions useful for glide exercises, but is not a categorical vowel label.

### Candidate confounders (held-out, clean)

| Context | Baseline accepted frames | Candidate removes |
|---|---:|---:|
| stressed vowel | 499 | 17 (3.4%) |
| unstressed vowel | 175 | 20 (11.4%) |
| vowel >12 dB below recent peak | 117 | 4 (3.4%) |
| other nasal | 72 | 40 (55.6%) |
| word-initial nasal | 16 | 9 (56.2%) |

Word starts and stress derive from automatic alignments; no claim of hand-verified onset timing. Fading-out and word-initial murmurs need targeted recordings beyond this convenience sample.

## Existing masking gates: ablation, not a shipped change

Both maskedF1 and maskedF2 were removed in an analysis-only generated copy of the actual estimator. No other computation changed. The comparison below includes all speaker splits; the gates were not retuned.

| Source | Noise | Baseline tracked % | Without masks tracked % | Baseline median errors | Without masks median errors | Additional raw accepted | Their median raw errors | Gross-error pairs / measured pairs |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| hillenbrand | clean | 78.8 | 86.6 | 20.0 / 40.9 | 21.4 / 42.9 | 220 | 8.9 / 25.8 | 25 / 174 |
| hillenbrand | 20 | 79.8 | 87.6 | 18.8 / 43.0 | 20.1 / 44.3 | 225 | 8.9 / 24.4 | 30 / 175 |
| hillenbrand | 15 | 78.8 | 87.6 | 18.7 / 45.7 | 19.8 / 46.7 | 253 | 11.9 / 27.9 | 42 / 202 |
| hillenbrand | 10 | 75.2 | 82.8 | 19.3 / 49.1 | 20.1 / 50.5 | 259 | 15.1 / 33.8 | 59 / 203 |
| hillenbrand | 5 | 58.4 | 63.9 | 21.2 / 58.1 | 22.8 / 60.2 | 217 | 27.0 / 60.2 | 75 / 187 |
| librispeech | clean | 49.6 | 51.1 | — / — | — / — | 103 | — / — | 0 / 0 |
| librispeech | 20 | 48.4 | 50.3 | — / — | — / — | 116 | — / — | 0 / 0 |
| librispeech | 15 | 45.7 | 47.5 | — / — | — / — | 121 | — / — | 0 / 0 |
| librispeech | 10 | 39.5 | 41.4 | — / — | — / — | 141 | — / — | 0 / 0 |
| librispeech | 5 | 30.2 | 31.9 | — / — | — / — | 124 | — / — | 0 / 0 |

A gross-error pair here means F1 absolute error >150 Hz or F2 >250 Hz (a descriptive engineering cutoff). The extra raw clean H95 frames include large errors as well as accurate recoveries. Both gates therefore remain unchanged; a higher acceptance rate alone is not enough. These measurements expose the coverage/error trade-off. No extra accepted LibriSpeech frame can be called accurate because that corpus lacks formant ground truth.

## Clean H95 gate attribution

| Ablation | Additional raw accepted | Median raw absolute F1 / F2 error Hz | Gross-error pairs / measured pairs |
|---|---:|---:|---:|
| without-mask-f1 | 41 | 14.9 / 31.7 | 6 / 37 |
| without-mask-f2 | 179 | 7.5 / 24.7 | 19 / 137 |

The 0.55 F2 masking rule is not universally harmless to real front vowels; it excludes accurate examples as well as preventing gross relabelling. Changing it safely needs a larger benchmark and a discriminating feature, not a relaxed threshold chosen from these few speakers.

## F3 diagnostic — no display shipped

A generated analysis-only copy returns the third pole passing the existing bandwidth/frequency filter. This is deliberately a naive candidate, not an F3 label. Measured only on clean H95, not on independently annotated r/w.

| Held-out group | Eligible frames | F3 error pairs | Median absolute error Hz | 90th percentile Hz | Error >300 Hz |
|---|---:|---:|---:|---:|---:|
| men | 289 | 203 | 56.5 | 1226.8 | 16.7% |
| women | 455 | 299 | 35.9 | 125.8 | 6.7% |
| boys | 379 | 253 | 29.8 | 187.7 | 8.3% |
| girls | 382 | 222 | 34.9 | 224.0 | 9.5% |

The long error tail and absent r/w-specific truth do not support shipping an F3 display or a universal r threshold.
