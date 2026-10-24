# Offline speech benchmark

The evaluation runs the real `estimateFormants` and `VowelTracker` with 50 ms windows, 25 ms hops and the default 5,500 Hz ceiling. It never runs in the app, and the app adds no network requests, recordings or uploads. Raw audio and downloaded corpus metadata belong outside the repository.

## Reproduce

Requirements: Node 24, Python 3, ffmpeg on PATH, `npm ci`. Keep at least 2 GiB free. This selection used about 120 MiB including all fixtures and results, with a temporary 107 MB noise ZIP during preparation.

```sh
python3 scripts/eval/prepare.py --data-dir /Users/Git/Articulate-overnight/data/vowels
node scripts/eval/run.ts --data-dir /Users/Git/Articulate-overnight/data/vowels --out /Users/Git/Articulate-overnight/data/vowels/baseline --label 'Patched baseline'
node scripts/eval/ablate.ts /Users/Git/Articulate-overnight/data/vowels/analysis-modules
node scripts/eval/run.ts --data-dir /Users/Git/Articulate-overnight/data/vowels --out /Users/Git/Articulate-overnight/data/vowels/without-masks --estimator /Users/Git/Articulate-overnight/data/vowels/analysis-modules/without-masks.ts
node scripts/eval/run.ts --data-dir /Users/Git/Articulate-overnight/data/vowels --out /Users/Git/Articulate-overnight/data/vowels/without-mask-f1 --estimator /Users/Git/Articulate-overnight/data/vowels/analysis-modules/without-mask-f1.ts --clean-only
node scripts/eval/run.ts --data-dir /Users/Git/Articulate-overnight/data/vowels --out /Users/Git/Articulate-overnight/data/vowels/without-mask-f2 --estimator /Users/Git/Articulate-overnight/data/vowels/analysis-modules/without-mask-f2.ts --clean-only
node scripts/eval/run.ts --data-dir /Users/Git/Articulate-overnight/data/vowels --out /Users/Git/Articulate-overnight/data/vowels/third-pole --estimator /Users/Git/Articulate-overnight/data/vowels/analysis-modules/third-pole.ts --corpus hillenbrand --clean-only
python3 scripts/eval/analyze.py --data-dir /Users/Git/Articulate-overnight/data/vowels --out eval-results
```

Use a distinct output prefix for a new version to preserve the baseline. Each run writes a Markdown table, JSON provenance, and gzipped per-frame records next to its output prefix. The corpus manifest and every prepared WAV have SHA-256 checks checked before evaluation. `ablate.ts` makes analysis-only source copies and fails if the expected source patterns change; these copies never enter the app bundle.

For the explicit-licence primary corpus alone, add `--corpus librispeech` to `run.ts`. `--clean-only` shortens exploratory runs. Hillenbrand is a supplementary, licence-qualified study, not part of an unqualified openly licensed claim.

## Sources and attribution

- **LibriSpeech / OpenSLR12:** Vassil Panayotov, Guoguo Chen, Daniel Povey and Sanjeev Khudanpur. [Official corpus page](https://www.openslr.org/12/) explicitly lists CC BY 4.0. The selected audio is public audiobook speech.
- **Phone alignments:** Loren Lugosch and colleagues, [published MFA alignments](https://zenodo.org/records/2619474), generated with a LibriSpeech-trained Montreal Forced Aligner. [Kim Gilkey's combined dataset card](https://huggingface.co/datasets/gilkeyio/librispeech-alignments) supplies per-record audio and phone timing, explicitly under CC BY 4.0. Dataset revision `0daa1eb43dda38ee6ce752e785555380e5628f5c`. The downloader refuses a changed upstream revision rather than silently changing the benchmark. Alignments are automatic, not hand-labelled truth.
- **DEMAND:** Joachim Thiemann, Nobutaka Ito and Emmanuel Vincent. [Primary record](https://zenodo.org/records/1227121) explicitly licenses its audio and documentation CC BY-SA 3.0. Use `PCAFETER_16k.zip`, channel 1 only, resampled to 48 kHz. Source ZIP MD5 from the record: `99927d148128254141a9417d051510bb`. No modified audio is redistributed.
- **Hillenbrand supplementary study:** James Hillenbrand, Laura A. Getty, Michael J. Clark and Kimberlee Wheeler (1995), *Acoustic characteristics of American English vowels*, [DOI](https://doi.org/10.1121/1.411872). The original WMU host returned 502 during setup. [Santiago Barreda's data-only mirror](https://github.com/santiagobarreda/hillenbrand_et_al_1995/tree/6dd44decc8ef5b537cbb54732a3b00c8fa652e65) states that the data and recordings are hosted with Jim Hillenbrand's permission. Its [root MIT licence](https://github.com/santiagobarreda/hillenbrand_et_al_1995/blob/6dd44decc8ef5b537cbb54732a3b00c8fa652e65/LICENSE) is ©2024 Santiago Barreda. The archive retains ©1995 James Hillenbrand notices. The root licence uses standard software/documentation wording and the audio has no separately stated licence in the archive. We report that evidence precisely; we do not infer an additional original-recordings licence or redistribute the audio. This source is explicitly exploratory. Source archive 21,748,822 bytes; mirror revision pinned above.

## Selection and splits

Prepared speech totals 166.291 s / 15,986,382 WAV bytes for H95 and 407.725 s / 39,145,278 WAV bytes for LibriSpeech. No speaker occurs in both splits. Selection precedes acoustic analysis and uses identifiers, not tracking success. This is a small convenience sample; it is not population-representative.

| Corpus | Selection | Development | Held-out |
|---|---|---|---|
| H95 | First six speaker IDs in each of men/women/boys/girls; all 12 vowels each | 12 speakers, 144 words | 12 speakers, 144 words |
| LibriSpeech dev_clean | First 200 viewer rows; first 12 numeric speaker IDs per supplied M/F category; up to first two rows per selected speaker | 12 speakers, 23 utterances | 12 speakers, 24 utterances |

Alternating IDs within each group/sex stratum sets the split. H95 development: b01,b03,b05,g01,g04,g06,m01,m03,m06,w01,w03,w05; held-out: b02,b04,b07,g02,g05,g07,m02,m04,m07,w02,w04,w06. LibriSpeech development: 84,174,422,777,1919,1993,2078,2277,2428,2902,3081,3576; held-out: 251,652,1272,1462,1988,2035,2086,2412,2803,3000,3536,3853.

## Reading the metrics

- A frame counts only if its entire 50 ms window is inside one known aligned phone. Boundaries, silence, unknown phones and most phones shorter than 50 ms are excluded. This reduces mixed-phone labelling but biases the sample toward longer segments. MFA boundary error remains; the alignments were not manually corrected.
- The tracker receives all frames, including excluded ones, in order. Times use window ends as in the AudioWorklet. F1/F2 errors compare with reference times at the window center, so tracked error includes smoothing lag.
- H95 `bigdata.dat` gives original F1/F2/F3 at 10–80% of vowel duration, and `timedata.dat` gives vowel boundaries. We linearly interpolate between those measured samples, never beyond them. Zero/missing F1/F2 excludes an error pair. These interpolated targets are not new hand measurements for each 50 ms window.
- Always read coverage beside error. Medians use accepted frames with measurable reference F1/F2; rejected frames have no error value. Both raw and tracked acceptance are reported. LibriSpeech has no formant ground truth, so its error cells are unavailable, not zero.
- Nominal SNR is annotated active-speech RMS divided by RMS of the whole chosen noise excerpt. A deterministic SHA-256-derived offset selects cafeteria noise; the same offset is used for every SNR of a clip. Nonstationary local SNR varies. Speech gain is unchanged; no limiter or normalization is applied. Over-range floating samples are counted, and the estimator's normal clipping guard still runs. This is an additive-noise stress test, not a recording from the actual hall.
- The clean nasal experiment re-filters already accepted positions using frame-level bands and recent-peak loudness. It is an optimistic discrimination check; it does not claim temporal classifier accuracy or test a production acquisition path. Candidate thresholds use development speakers only. The held-out set is reported once for that selection. No tested rule met the screen, so nothing is deployed.
- F3 is only the third eligible LPC pole in an analysis copy. Pole rank is not reliable formant identity. There is no independently measured r/w F3 ground truth here, so no r/w threshold or F3 UI is justified.

## Browser checks and screenshots

Start an owned server on an isolated port, then run:

```sh
npm run dev -- --port 5181 --strictPort
# In another terminal:
node scripts/eval/browser.ts --data-dir /Users/Git/Articulate-overnight/data/vowels --url http://127.0.0.1:5181 --screenshots /Users/Git/Articulate-overnight/screenshots/vowels
```

`browser.ts` launches Chromium with `--use-file-for-fake-audio-capture`; it does not replace `getUserMedia`. Speech passes through the real microphone API, AudioWorklet, Worker, tracker and React UI. Four fixtures exercise a repeated real vowel excerpt, an original h-V-d word, a natural sentence containing nasals, and an original /eɪ/ word. The excerpt repetition and Chromium file looping are artificial. These checks establish pipeline integration; screenshots do not establish phone identification, frame alignment or acoustic accuracy. Human microphone placement, Safari constraints and noisy live speech remain morning checks.
