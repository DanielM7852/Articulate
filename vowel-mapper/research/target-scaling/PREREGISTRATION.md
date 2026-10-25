# Speaker-scaled vowel targets: offline Hillenbrand check

Written 2026-10-24, before any result was computed. Agreed in interview: target
option (c), a published reference scaled to the speaker by one uniform factor
estimated from speech other than the target vowel.

## Question

Does one uniform speaker-size factor, applied to a pooled reference, produce
target regions that contain listener-identified target vowels for men, women,
boys and girls, while rejecting listener-identified neighbouring vowels better
than the team's fixed demonstration regions?

This tests target construction on hand-measured formants only. It does not test
the browser tracker, noise, DHH speech, or whether a region is a valid training
goal.

## Data

`h95-alldata.zip` (SHA-256 2560548591e3a726c88549b6dc9d226995616c26874d601c69fee8b9eee9d730):
`bigdata.dat` steady-state F1/F2, `iddata.dat` 20-listener votes. All 139
speakers. Tokens with an unmeasurable (zero) F1 or F2 are excluded.

- Perceived label = listener majority vote (`iddata.dat` column 15), not the
  talker's intended vowel.
- Targets T: iy (/i/), ah (/ɑ/), uw (/u/), matching the app.
- Neighbours N(T): iy → {ih, ei}; ah → {aw, uh}; uw → {oo, oa}.

## Method

Space: natural log of Hz. Five speaker-disjoint folds, stratified by group
(sorted speaker IDs assigned round-robin within each group). Everything below
is fitted on the four training folds and applied to the held-out fold.

- **Reference fit:** training tokens whose perceived label equals the intended
  label. Alternate 10 times: per-vowel reference mean R_v = mean(lnF − S_spk);
  per-speaker S_spk = mean over the speaker's tokens and both formants of
  (lnF − R_v); then centre S to mean 0.
- **Speaker factor for a held-out speaker and target T:** S = mean(lnF − R_v)
  over their tokens of vowels outside {T} ∪ N(T), using **intended** labels
  (the app knows the phrase it asked for, not what was produced).

Arms (the region is an axis-aligned ellipse; a token is inside when its
normalised distance is ≤ 1):

- **A, team fixed:** Hz centres i 300/2300, u 350/900, ɑ 750/1200; radii
  160/350 Hz (`services/api/app/schemas.py`).
- **C1, scaled (primary):** centre R_T + S; radius k·SD of the training
  residuals (lnF − S_spk − R_T) for each axis; k = 2.
- **C0, pooled, unscaled (ablation):** centre is the pooled training mean of
  lnF; radius k·SD of the unscaled values.
- **C2, age/sex group norm (comparison):** centre and k·SD from training
  speakers of the same group; no S.

## Metrics, held-out speakers

- Hit: share of tokens perceived as T that fall inside T's region.
- Neighbour false accept: share of tokens perceived as a vowel in N(T) that
  fall inside T's region.
- Any-other false accept: share of tokens perceived as any vowel ≠ T inside it.
- Centralisation: shrink each held-out speaker's lnF toward their own centroid
  by 30%; report |ΔS| relative to the mean C1 radius, and the C1 hit rate on the
  shrunken T tokens. A personal warm-up zone accepts them by construction.

## Pass criteria (engineering heuristics, not clinical standards)

- **P1:** C1 hit ≥ 80% averaged over the three targets within every group, with
  no group × target cell below 65%.
- **P2:** C1 neighbour false accept ≤ 15% averaged over targets within every
  group.
- **P3:** boys + girls pooled: C1 hit − A hit ≥ 15 points, and C1 neighbour
  false accept ≤ A's + 5 points.
- **P4:** median |ΔS| under 30% centralisation ≤ 0.25 × mean C1 radius.

All four pass → adopt C1 as the proposed target model for a tracker-based
check. Any fail → report which, and do not tune k or the method on these
results before deciding with the user. Secondary, never used for pass/fail:
k ∈ {1.5, 2.5}, and S estimated from all 12 vowels including T (the circular
variant).

---

## Amendment 1: two-factor refinement (written 2026-10-24, after the primary results, before any refinement or Peterson & Barney result)

Primary outcome, recorded unchanged: P1 FAIL, P2 FAIL, P3 PASS, P4 PASS. The
user adopted C1 as the proposed target model with /u/ marked as a broad region
that may overlap /ʊ/ and /o/.

### Hypothesis

Children's formants do not scale perfectly uniformly. Separate speaker factors
for F1 and F2 (S1, S2) will raise children's hit rate, mainly for /ɑ/, without
materially raising neighbour false accepts.

**C1b** is C1 with S_spk replaced by (S1_spk, S2_spk): each is the mean over the
speaker's tokens of (lnF_k − R_v,k) for formant k alone, in both the reference
fit and the held-out estimate. It still uses only vowels outside {T} ∪ N(T), and
keeps k = 2 and radii from the training residuals. Barreda (2021) found listeners
accommodate uniform scaling; a second parameter may absorb some phonetically
meaningful difference, which the centralisation check measures.

### Stage 1, exploratory: Hillenbrand children

The same 5-fold design as before. These speakers have already been seen, so
this stage cannot confirm anything; it only checks the refinement behaves as
intended before the confirmatory test.

### Stage 2, confirmatory: Peterson & Barney (1952)

Source: the `pb52` data in the CRAN package phonTools (BSD licence), kept
outside Git. Fit references for C1 and C1b on **all** Hillenbrand speakers and
apply them unchanged to every Peterson & Barney speaker. This is a
cross-dataset, cross-era, cross-dialect transfer, which mirrors the app: a
published reference applied to a new person.

- Groups: men, women, children (P&B does not split children by sex).
- Labels: intended vowel. P&B listener results are not available per token
  here, so labels are weaker than Hillenbrand's listener votes.
- Vowel mapping to Hillenbrand codes. Neighbours: /i/ → {ɪ} (P&B has no /eɪ/);
  /ɑ/ → {ɔ, ʌ}; /u/ → {ʊ} (no /o/). The speaker factor uses vowels outside
  {T} ∪ N(T) that exist in both sets.
- Arm A (team fixed regions) is evaluated too.

### Stage 2 criteria

- P1–P4 exactly as in the primary design, applied per P&B group to C1 and C1b
  separately, with "boys + girls" read as "children" in P3. For C1b, P4 uses
  the mean of |ΔS1| and |ΔS2|.
- **Refinement adopted** only if, on P&B children, C1b's hit rate is ≥ 5 points
  above C1's **and** its neighbour false accept is no more than 3 points above
  C1's **and** C1b passes P4. Otherwise keep C1.

### Amendment 1 outcome (recorded 2026-10-24)

Stage 1 (exploratory): C1b lowered children's hit rate (63.8% vs 73.0%) and
weakened centralisation robustness. Stage 2 (confirmatory, P&B): C1 and C1b
both fail P1–P3 and pass P4; children's hit rate is 25.6% (C1) vs 24.4% (C1b).
**Refinement rule: keep C1.**

Post hoc diagnostic (`diagnose_transfer.py`, exploratory): P&B target tokens sit
at a consistent offset from the scaled Hillenbrand centres, nearly identical for
men, women and children. Examples: /i/ F1 about −1.25 radii in all three groups;
/ɑ/ F2 −0.8 to −1.2; /u/ F1 −0.7 to −1.1. Speaker scaling removed the group
differences, but the vowel centres differ between the two datasets (era/dialect
and/or formant-measurement method). Within-dataset k = 2 regions are too narrow
to absorb that shift. This diagnostic was not used to change any criterion.

---

## Amendment 2: reference measured by the app's own tracker (written 2026-10-24, before any tracker-measured result)

Agreed with the user: re-measure the reference through the app's own pipeline,
use graded feedback in the product, and run the user's live check next.

### Instrument

Production `estimateFormants` + `VowelTracker` from `overnight/combined`
(`f7f3074`), run by the unmodified `scripts/eval/run.ts`, clean condition only:
48 kHz, 50 ms windows, 25 ms hops, 5,500 Hz ceiling. All 139 Hillenbrand
speakers' recordings come from the checksummed archive, resampled with the same
ffmpeg command as `prepare.py`, into a separate data directory outside Git.

### Token value

The median of tracker-**accepted** F1 and F2 over frames wholly inside the
vowel interval (`timedata.dat`). A token with fewer than 3 accepted frames is
excluded; coverage is reported by group and vowel, because exclusions can hide
failure.

### Arms (listener labels, the same speaker-stratified 5 folds, k = 2, P1–P4 unchanged)

- **A:** team fixed regions on the tracker values.
- **T1:** C1 built and tested entirely on tracker values; factor from vowels
  outside {T} ∪ N(T), as before.
- **T1-cal3 (the deployable variant, primary for the live check):** the same,
  but the held-out factor uses only /ɛ/ "head", /æ/ "had" and /ɝ/ "heard". None
  of these is a target or neighbour, so one short prompt set serves all three
  targets.

Also reported, not pass/fail: the median tracker-minus-hand log difference per
vowel and group (instrument bias), and the same table for hand values (C1) on
the identical retained tokens.

### Decision

- The live check proceeds whatever the outcome. It answers a different question
  (this instrument, the user's voice and microphone, the hall).
- If T1-cal3 passes P1 and P4, the live prototype may label a reached region
  "inside the reference region for your voice." Otherwise the prototype shows
  graded distance/direction only, with no inside/outside wording.
- The deployable reference is then refitted on all 139 speakers with the same
  method, versioned, and saved with its provenance.

### Amendment 2 outcome (recorded 2026-10-24)

T1-cal3: P1 FAIL, P2 FAIL, P3 FAIL, P4 PASS. Under the pre-registered rule the
live prototype shows **graded distance/direction only**. /i/ and /ɑ/ performed
well through the tracker (hits 84–88% and 71–83%; neighbour false accepts
1–8% and 0–26%). /u/ failed: the tracker-measured /u/ region spans about ±100%
in F1 and F2, because the tracker's /u/ measurements scatter widely, so it
accepts 97–99% of /ʊ/ and /o/ tokens. Women's /u/ also shows the largest
instrument bias (+10% F1, +16% F2). Consequence: /u/ is unscored in the live
check. This was decided after seeing results and is recorded as such.

---

## Live check outcome (one speaker, user's laptop, 2026-10-24)

Quiet (19:40Z): calibration 6/6, ee median 1.20, ah 0.60: all PASS. Factor −0.200.
Hall (19:44Z): coverage 6/6 PASS; factor −0.135, shift 0.46 radius FAIL; ee
distance change 0.74 FAIL (F1 ≈ 305 → 445 Hz, F2 ≈ unchanged); ah change 0.14
PASS. Candidate causes, not separated: louder, higher speech in noise raising F1,
or noise biasing low-F1 estimates. Proposed next test: repeat the hall run with a
close microphone.

Hall repeat with the user's headphones (19:52Z): factor −0.133 (shift ≈ 0.47
radius vs quiet, FAIL); ee 3.10 / 2.14 / 2.79, median 2.79 (change ≈ 1.59, FAIL;
F1 ≈ 430–505 Hz, F2 ≈ 1,840–1,910 Hz); ah 0.87 / 1.13 / 1.03, median 1.03
(change ≈ 0.43, PASS); coverage 6/6 PASS. The quiet run was no longer in that
browser's storage, so the comparisons were computed by hand from the logged quiet
values. Two different microphones gave the same hall factor (−0.135, −0.133), and
both showed raised ee F1. With the closer mic the ee result got worse, not better.
This points towards the speaker's own hall voice (louder speech in noise) rather
than mic noise, but the two causes are still not separated. Decision per the agreed
rule: the demo leads with "ah", and "ee" is shown on the map without closer/farther
coaching in noise.

---

## Amendment 3: voice sizing without correct pronunciation (written before running, 2026-10-24)

**Why.** The deployable factor comes from head / had / heard. A deaf learner who cannot yet produce
those vowels gets a wrong factor, which misplaces every target. Test sources that do not depend on
producing particular vowels.

**Data.** All Hillenbrand speakers, tracker-measured F1/F2 (as Amendment 2, ≥3 accepted frames).
Pitch (F0) and F3 are Hillenbrand's hand measurements, as stand-ins for an in-app measurement that
does not exist yet. Same 5 speaker folds; every fit uses training folds only.

**Truth.** Oracle factor = the speaker's factor from all 12 vowels (evaluation only).

**Methods.**
- `cal3`: head / had / heard (current).
- `cal3-uh`: stress test: the learner says all three check words as their own "uh" (/ʌ/ token).
- `none`: no scaling (pooled reference).
- `group`: training mean factor for the speaker's group (man / woman / boy / girl), as if picked from a menu.
- `uh`: factor from one held "uh" (/ʌ/) token's F1/F2.
- `f0`: linear fit of factor on log F0 of the "uh" token.
- `f3`: linear fit of factor on log F3 of the "uh" token.
- `f0f3`: both.

**Primary measure.** Absolute factor error vs the oracle, in mean reference radii (ee/ah), per group:
median and 90th percentile.

**Deploy rule for learners who cannot do the check words.** A method qualifies if its 90th-percentile
error is ≤ 0.5 radius (half the distance to ring 2's edge) in all four groups. Among qualifiers, prefer
the one with the lowest worst-group 90th percentile. If none qualifies, the app uses the best method
anyway, labelled as approximate, and recommends a therapist-set size. Hit rates for ee/ah are reported,
not judged.

### Amendment 3 outcome (recorded 2026-10-24)

Full table: `results/voice-size.md`. Factor error vs the all-vowel factor, 90th percentile in reference radii
(men · women · boys · girls):

- `cal3` (current, words said as intended): 0.31 · 0.51 · 0.37 · 0.37.
- `cal3-uh` (check words all said as "uh"): 0.96 · 1.26 · 1.37 · 1.17; ee hits fall to 9–60%. The current check
  fails badly for a learner who cannot yet produce the check vowels.
- No pre-registered pronunciation-free method qualified (≤ 0.5 in all groups). Best: `uh` 0.69, `group` 0.70.
  Per the rule, the best one would ship labelled as approximate.
- Exploratory, chosen after seeing the above: `uh+group` (mean of one held "uh" and the man/woman/boy/girl menu)
  reached 0.38 · 0.55 · 0.41 · 0.40, close to `cal3` and needing no new measurement. Weak spot: boys' ee hits 61%
  (cal3 90%). Adding pitch/F3 (`uh+group+f0f3`) did not help further. Not confirmed: needs a fresh check, and
  Hillenbrand speakers are hearing adults and children, not deaf learners.
