# Voice-sized vowel targets: pre-registered evaluation

> Copied from Karsten's vowel-mapper work (branch `Karsten`, folder `vowel-mapper/`), Oct 24, 2026. Paths and links refer to that branch. Scripts and data are not on this branch.

Can one fixed vowel target fit every learner, or does it have to be sized to the voice? Tested on Hillenbrand et al. (1995): 139 speakers (45 men, 48 women, 27 boys, 19 girls), 1,658 words with listener labels. Peterson & Barney (1952) was used as an out-of-dataset check. The plan was written before each result; the amendments record what changed and why.

Outcome in brief:
- One uniform voice multiplier per learner (Amendment 1 rejected separate F1/F2 factors).
- The reference re-measured by the app's own tracker (Amendment 2) gives 84–88% "ee" hits in every group.
- "oo" is unscored because the tracker scatters it too widely.
- The pass criteria failed out of dataset, so the live UI shows graded distance only.
- Voice sizing from one held "uh" plus a Man/Woman/Boy/Girl choice comes close to sizing from head/had/heard (Amendment 3, exploratory).
- The web app's current fixed regions (`web/src/vowel/targets.ts` on `main`), scored on the same tokens, are in the last section.

## Pre-registration and amendments

Source: `vowel-mapper/research/target-scaling/PREREGISTRATION.md`


Written 2026-10-24, before any result was computed. Agreed in interview: target
option (c), a published reference scaled to the speaker by one uniform factor
estimated from speech other than the target vowel.

### Question

Does one uniform speaker-size factor, applied to a pooled reference, produce
target regions that contain listener-identified target vowels for men, women,
boys and girls, while rejecting listener-identified neighbouring vowels better
than the team's fixed demonstration regions?

This tests target construction on hand-measured formants only. It does not test
the browser tracker, noise, DHH speech, or whether a region is a valid training
goal.

### Data

`h95-alldata.zip` (SHA-256 2560548591e3a726c88549b6dc9d226995616c26874d601c69fee8b9eee9d730):
`bigdata.dat` steady-state F1/F2, `iddata.dat` 20-listener votes. All 139
speakers. Tokens with an unmeasurable (zero) F1 or F2 are excluded.

- Perceived label = listener majority vote (`iddata.dat` column 15), not the
  talker's intended vowel.
- Targets T: iy (/i/), ah (/ɑ/), uw (/u/), matching the app.
- Neighbours N(T): iy → {ih, ei}; ah → {aw, uh}; uw → {oo, oa}.

### Method

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

### Metrics, held-out speakers

- Hit: share of tokens perceived as T that fall inside T's region.
- Neighbour false accept: share of tokens perceived as a vowel in N(T) that
  fall inside T's region.
- Any-other false accept: share of tokens perceived as any vowel ≠ T inside it.
- Centralisation: shrink each held-out speaker's lnF toward their own centroid
  by 30%; report |ΔS| relative to the mean C1 radius, and the C1 hit rate on the
  shrunken T tokens. A personal warm-up zone accepts them by construction.

### Pass criteria (engineering heuristics, not clinical standards)

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

### Amendment 1: two-factor refinement (written 2026-10-24, after the primary results, before any refinement or Peterson & Barney result)

Primary outcome, recorded unchanged: P1 FAIL, P2 FAIL, P3 PASS, P4 PASS. The
user adopted C1 as the proposed target model with /u/ marked as a broad region
that may overlap /ʊ/ and /o/.

#### Hypothesis

Children's formants do not scale perfectly uniformly. Separate speaker factors
for F1 and F2 (S1, S2) will raise children's hit rate, mainly for /ɑ/, without
materially raising neighbour false accepts.

**C1b** is C1 with S_spk replaced by (S1_spk, S2_spk): each is the mean over the
speaker's tokens of (lnF_k − R_v,k) for formant k alone, in both the reference
fit and the held-out estimate. It still uses only vowels outside {T} ∪ N(T), and
keeps k = 2 and radii from the training residuals. Barreda (2021) found listeners
accommodate uniform scaling; a second parameter may absorb some phonetically
meaningful difference, which the centralisation check measures.

#### Stage 1, exploratory: Hillenbrand children

The same 5-fold design as before. These speakers have already been seen, so
this stage cannot confirm anything; it only checks the refinement behaves as
intended before the confirmatory test.

#### Stage 2, confirmatory: Peterson & Barney (1952)

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

#### Stage 2 criteria

- P1–P4 exactly as in the primary design, applied per P&B group to C1 and C1b
  separately, with "boys + girls" read as "children" in P3. For C1b, P4 uses
  the mean of |ΔS1| and |ΔS2|.
- **Refinement adopted** only if, on P&B children, C1b's hit rate is ≥ 5 points
  above C1's **and** its neighbour false accept is no more than 3 points above
  C1's **and** C1b passes P4. Otherwise keep C1.

#### Amendment 1 outcome (recorded 2026-10-24)

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

### Amendment 2: reference measured by the app's own tracker (written 2026-10-24, before any tracker-measured result)

Agreed with the user: re-measure the reference through the app's own pipeline,
use graded feedback in the product, and run the user's live check next.

#### Instrument

Production `estimateFormants` + `VowelTracker` from `overnight/combined`
(`f7f3074`), run by the unmodified `scripts/eval/run.ts`, clean condition only:
48 kHz, 50 ms windows, 25 ms hops, 5,500 Hz ceiling. All 139 Hillenbrand
speakers' recordings come from the checksummed archive, resampled with the same
ffmpeg command as `prepare.py`, into a separate data directory outside Git.

#### Token value

The median of tracker-**accepted** F1 and F2 over frames wholly inside the
vowel interval (`timedata.dat`). A token with fewer than 3 accepted frames is
excluded; coverage is reported by group and vowel, because exclusions can hide
failure.

#### Arms (listener labels, the same speaker-stratified 5 folds, k = 2, P1–P4 unchanged)

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

#### Decision

- The live check proceeds whatever the outcome. It answers a different question
  (this instrument, the user's voice and microphone, the hall).
- If T1-cal3 passes P1 and P4, the live prototype may label a reached region
  "inside the reference region for your voice." Otherwise the prototype shows
  graded distance/direction only, with no inside/outside wording.
- The deployable reference is then refitted on all 139 speakers with the same
  method, versioned, and saved with its provenance.

#### Amendment 2 outcome (recorded 2026-10-24)

T1-cal3: P1 FAIL, P2 FAIL, P3 FAIL, P4 PASS. Under the pre-registered rule the
live prototype shows **graded distance/direction only**. /i/ and /ɑ/ performed
well through the tracker (hits 84–88% and 71–83%; neighbour false accepts
1–8% and 0–26%). /u/ failed: the tracker-measured /u/ region spans about ±100%
in F1 and F2, because the tracker's /u/ measurements scatter widely, so it
accepts 97–99% of /ʊ/ and /o/ tokens. Women's /u/ also shows the largest
instrument bias (+10% F1, +16% F2). Consequence: /u/ is unscored in the live
check. This was decided after seeing results and is recorded as such.

---

### Live check outcome (one speaker, user's laptop, 2026-10-24)

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

### Amendment 3: voice sizing without correct pronunciation (written before running, 2026-10-24)

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

#### Amendment 3 outcome (recorded 2026-10-24)

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

## Primary results (hand-measured formants)

Source: `vowel-mapper/research/target-scaling/results/results.md`


Speakers 139 (men 45, women 48, boys 27, girls 19); tokens 1658; tokens lacking listener votes 0. k = 2.0.

### Pass criteria

- P1 C1 hit >= 80% per group, no cell < 65%: **FAIL**
- P2 C1 neighbour false accept <= 15% per group: **FAIL**
- P3 children: C1 hit - A hit = 64.5 pts (>= 15), C1 nFA 15.8% vs A 18.0% (<= A + 5): **PASS**
- P4 median |dS| / mean C1 radius under 30% centralisation = 0.067 (<= 0.25): **PASS**

#### Primary: k = 2, factor from non-target vowels

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| A | men | 98 / 98 / 96 (mean 97) | 19 / 83 / 57 (mean 53) | 9.6 |
| A | women | 4 / 25 / 52 (mean 27) | 8 / 85 / 18 (mean 37) | 7.9 |
| A | boys | 0 / 11 / 16 (mean 9) | 0 / 69 / 2 (mean 24) | 5.3 |
| A | girls | 0 / 5 / 20 (mean 8) | 0 / 26 / 14 (mean 13) | 3.4 |
| C0 | men | 60 / 72 / 84 (mean 72) | 18 / 2 / 96 (mean 39) | 10.5 |
| C0 | women | 100 / 96 / 100 (mean 99) | 67 / 70 / 69 (mean 68) | 14.0 |
| C0 | boys | 96 / 93 / 96 (mean 95) | 47 / 69 / 28 (mean 48) | 9.4 |
| C0 | girls | 89 / 68 / 50 (mean 69) | 56 / 82 / 32 (mean 57) | 11.0 |
| C2 | men | 87 / 78 / 78 (mean 81) | 6 / 7 / 9 (mean 7) | 1.3 |
| C2 | women | 81 / 83 / 83 (mean 83) | 24 / 27 / 52 (mean 34) | 6.6 |
| C2 | boys | 78 / 75 / 84 (mean 79) | 5 / 12 / 38 (mean 19) | 4.0 |
| C2 | girls | 74 / 73 / 85 (mean 77) | 8 / 26 / 30 (mean 21) | 4.2 |
| C1 | men | 82 / 80 / 89 (mean 84) | 6 / 6 / 17 (mean 9) | 1.7 |
| C1 | women | 83 / 85 / 81 (mean 83) | 11 / 26 / 48 (mean 28) | 5.6 |
| C1 | boys | 70 / 61 / 92 (mean 74) | 13 / 2 / 23 (mean 12) | 2.3 |
| C1 | girls | 95 / 59 / 65 (mean 73) | 8 / 9 / 43 (mean 20) | 3.7 |

#### Centralisation (30% toward own centroid), C1

| Target | median abs dS (ln) | mean C1 radius (ln) | C1 hit on centralised target tokens |
|---|---|---|---|
| iy | 0.0097 | 0.144 | 6% |
| ah | 0.0048 | 0.169 | 57% |
| uw | 0.0257 | 0.246 | 66% |

### Secondary (not used for pass/fail)

#### k = 1.5

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| A | men | 98 / 98 / 96 (mean 97) | 19 / 83 / 57 (mean 53) | 9.6 |
| A | women | 4 / 25 / 52 (mean 27) | 8 / 85 / 18 (mean 37) | 7.9 |
| A | boys | 0 / 11 / 16 (mean 9) | 0 / 69 / 2 (mean 24) | 5.3 |
| A | girls | 0 / 5 / 20 (mean 8) | 0 / 26 / 14 (mean 13) | 3.4 |
| C0 | men | 31 / 43 / 64 (mean 46) | 8 / 0 / 71 (mean 26) | 7.5 |
| C0 | women | 94 / 87 / 88 (mean 89) | 38 / 45 / 46 (mean 43) | 8.0 |
| C0 | boys | 78 / 71 / 64 (mean 71) | 22 / 46 / 13 (mean 27) | 4.7 |
| C0 | girls | 42 / 50 / 35 (mean 42) | 28 / 71 / 14 (mean 37) | 6.6 |
| C2 | men | 58 / 59 / 58 (mean 58) | 2 / 2 / 4 (mean 3) | 0.5 |
| C2 | women | 69 / 60 / 69 (mean 66) | 11 / 18 / 41 (mean 23) | 4.2 |
| C2 | boys | 59 / 54 / 68 (mean 60) | 0 / 6 / 17 (mean 8) | 1.7 |
| C2 | girls | 58 / 50 / 50 (mean 53) | 3 / 15 / 14 (mean 10) | 1.9 |
| C1 | men | 60 / 61 / 78 (mean 66) | 2 / 4 / 2 (mean 3) | 0.5 |
| C1 | women | 69 / 62 / 71 (mean 67) | 4 / 13 / 30 (mean 16) | 3.0 |
| C1 | boys | 44 / 50 / 56 (mean 50) | 7 / 2 / 8 (mean 6) | 1.0 |
| C1 | girls | 68 / 32 / 25 (mean 42) | 3 / 6 / 16 (mean 8) | 1.5 |

#### k = 2.5

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| A | men | 98 / 98 / 96 (mean 97) | 19 / 83 / 57 (mean 53) | 9.6 |
| A | women | 4 / 25 / 52 (mean 27) | 8 / 85 / 18 (mean 37) | 7.9 |
| A | boys | 0 / 11 / 16 (mean 9) | 0 / 69 / 2 (mean 24) | 5.3 |
| A | girls | 0 / 5 / 20 (mean 8) | 0 / 26 / 14 (mean 13) | 3.4 |
| C0 | men | 98 / 83 / 93 (mean 91) | 64 / 9 / 99 (mean 57) | 16.3 |
| C0 | women | 100 / 100 / 100 (mean 100) | 85 / 82 / 80 (mean 83) | 19.0 |
| C0 | boys | 100 / 100 / 96 (mean 99) | 82 / 88 / 58 (mean 76) | 16.4 |
| C0 | girls | 100 / 82 / 85 (mean 89) | 85 / 100 / 54 (mean 80) | 17.0 |
| C2 | men | 98 / 93 / 91 (mean 94) | 6 / 19 / 26 (mean 17) | 3.2 |
| C2 | women | 92 / 89 / 94 (mean 91) | 30 / 40 / 65 (mean 45) | 9.1 |
| C2 | boys | 93 / 86 / 88 (mean 89) | 5 / 23 / 66 (mean 31) | 6.9 |
| C2 | girls | 84 / 86 / 95 (mean 89) | 15 / 50 / 57 (mean 41) | 10.2 |
| C1 | men | 96 / 85 / 96 (mean 92) | 9 / 16 / 33 (mean 19) | 3.9 |
| C1 | women | 96 / 91 / 98 (mean 95) | 24 / 44 / 64 (mean 44) | 9.3 |
| C1 | boys | 74 / 82 / 96 (mean 84) | 13 / 6 / 42 (mean 20) | 4.3 |
| C1 | girls | 100 / 91 / 70 (mean 87) | 23 / 21 / 62 (mean 35) | 6.9 |

#### Circular variant: factor estimated from all 12 vowels, including the target

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| A | men | 98 / 98 / 96 (mean 97) | 19 / 83 / 57 (mean 53) | 9.6 |
| A | women | 4 / 25 / 52 (mean 27) | 8 / 85 / 18 (mean 37) | 7.9 |
| A | boys | 0 / 11 / 16 (mean 9) | 0 / 69 / 2 (mean 24) | 5.3 |
| A | girls | 0 / 5 / 20 (mean 8) | 0 / 26 / 14 (mean 13) | 3.4 |
| C0 | men | 60 / 72 / 84 (mean 72) | 18 / 2 / 96 (mean 39) | 10.5 |
| C0 | women | 100 / 96 / 100 (mean 99) | 67 / 70 / 69 (mean 68) | 14.0 |
| C0 | boys | 96 / 93 / 96 (mean 95) | 47 / 69 / 28 (mean 48) | 9.4 |
| C0 | girls | 89 / 68 / 50 (mean 69) | 56 / 82 / 32 (mean 57) | 11.0 |
| C2 | men | 87 / 78 / 78 (mean 81) | 6 / 7 / 9 (mean 7) | 1.3 |
| C2 | women | 81 / 83 / 83 (mean 83) | 24 / 27 / 52 (mean 34) | 6.6 |
| C2 | boys | 78 / 75 / 84 (mean 79) | 5 / 12 / 38 (mean 19) | 4.0 |
| C2 | girls | 74 / 73 / 85 (mean 77) | 8 / 26 / 30 (mean 21) | 4.2 |
| C1 | men | 91 / 80 / 91 (mean 88) | 7 / 6 / 16 (mean 9) | 1.7 |
| C1 | women | 90 / 85 / 83 (mean 86) | 14 / 24 / 48 (mean 28) | 5.4 |
| C1 | boys | 70 / 75 / 96 (mean 80) | 11 / 2 / 25 (mean 13) | 2.4 |
| C1 | girls | 100 / 68 / 65 (mean 78) | 8 / 6 / 43 (mean 19) | 3.5 |

## Amendment 1: one vs two factors

Source: `vowel-mapper/research/target-scaling/results/refinement.md`


Peterson & Barney: 1520 tokens, speakers {'men': 33, 'women': 28, 'children': 15}. Hillenbrand: 1658 tokens.

**Refinement rule (P&B children: C1b hit ≥ C1 + 5, neighbour FA ≤ C1 + 3, C1b passes P4): KEEP C1** (hit 24.4 vs 25.6; neighbour FA 36.7 vs 33.3).

### Stage 2 (confirmatory): fit on all Hillenbrand, applied to Peterson & Barney

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| A | men | 97 / 97 / 92 (mean 95) | 39 / 44 / 83 (mean 56) | 8.5 |
| A | women | 5 / 66 / 93 (mean 55) | 38 / 57 / 41 (mean 45) | 7.9 |
| A | children | 0 / 10 / 40 (mean 17) | 3 / 45 / 0 (mean 16) | 4.4 |
| C1 | men | 29 / 65 / 44 (mean 46) | 17 / 26 / 29 (mean 24) | 3.6 |
| C1 | women | 20 / 34 / 54 (mean 36) | 48 / 34 / 55 (mean 46) | 6.8 |
| C1 | children | 17 / 27 / 33 (mean 26) | 27 / 30 / 47 (mean 34) | 5.4 |
| C1b | men | 17 / 47 / 36 (mean 33) | 23 / 30 / 27 (mean 27) | 4.0 |
| C1b | women | 16 / 12 / 52 (mean 27) | 52 / 33 / 50 (mean 45) | 6.5 |
| C1b | children | 20 / 13 / 40 (mean 24) | 33 / 32 / 50 (mean 38) | 5.8 |

| Arm | Centralisation: median |dS| / radius (iy / ah / uw) | Hit on centralised target |
|---|---|---|
| C1 | 0.027 / 0.021 / 0.094 | 30% / 68% / 78% |
| C1b | 0.237 / 0.223 / 0.100 | 19% / 57% / 76% |

| Arm | P1 | P2 | P3 | P4 | Children hit % | Children neighbour FA % |
|---|---|---|---|---|---|---|
| C1 | FAIL | FAIL | FAIL | PASS | 25.6 | 33.3 |
| C1b | FAIL | FAIL | FAIL | PASS | 24.4 | 36.7 |

### Stage 1 (exploratory): Hillenbrand, 5-fold, listener labels

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| A | men | 98 / 98 / 96 (mean 97) | 19 / 83 / 57 (mean 53) | 9.6 |
| A | women | 4 / 25 / 52 (mean 27) | 8 / 85 / 18 (mean 37) | 7.9 |
| A | boys | 0 / 11 / 16 (mean 9) | 0 / 69 / 2 (mean 24) | 5.3 |
| A | girls | 0 / 5 / 20 (mean 8) | 0 / 26 / 14 (mean 13) | 3.4 |
| C1 | men | 82 / 80 / 89 (mean 84) | 6 / 6 / 17 (mean 9) | 1.7 |
| C1 | women | 83 / 85 / 81 (mean 83) | 11 / 26 / 48 (mean 28) | 5.6 |
| C1 | boys | 70 / 61 / 92 (mean 74) | 13 / 2 / 23 (mean 12) | 2.3 |
| C1 | girls | 95 / 59 / 65 (mean 73) | 8 / 9 / 43 (mean 20) | 3.7 |
| C1b | men | 80 / 78 / 87 (mean 82) | 7 / 6 / 14 (mean 9) | 1.6 |
| C1b | women | 81 / 77 / 81 (mean 80) | 15 / 26 / 46 (mean 29) | 5.5 |
| C1b | boys | 52 / 61 / 80 (mean 64) | 13 / 2 / 17 (mean 11) | 1.9 |
| C1b | girls | 89 / 45 / 60 (mean 65) | 8 / 9 / 30 (mean 15) | 2.7 |

| Arm | Centralisation: median |dS| / radius (iy / ah / uw) | Hit on centralised target |
|---|---|---|
| C1 | 0.068 / 0.028 / 0.103 | 6% / 57% / 66% |
| C1b | 0.226 / 0.150 / 0.110 | 1% / 44% / 67% |

| Arm | P1 | P2 | P3 | P4 | Children hit % | Children neighbour FA % |
|---|---|---|---|---|---|---|
| C1 | FAIL | FAIL | PASS | PASS | 73.0 | 15.8 |
| C1b | FAIL | FAIL | PASS | PASS | 63.8 | 12.8 |

## Amendment 2: reference measured by the app's tracker

Source: `vowel-mapper/research/target-scaling/results/tracker.md`


Instrument: production estimator SHA-256 `cd8feb87a323b741…`, manifest `2461447b87bb26af…`. Tokens retained (≥3 accepted frames): 1526 of 1658.

### Pass criteria

| Arm | P1 | P2 | P3 | P4 | Centralisation ratio |
|---|---|---|---|---|---|
| T1 | FAIL | FAIL | FAIL | PASS | 0.034 |
| T1-cal3 | FAIL | FAIL | FAIL | PASS | 0.130 |
| C1-hand-same-tokens | FAIL | FAIL | PASS | PASS | 0.066 |

**Live prototype wording (pre-registered rule on T1-cal3):** shows **graded distance/direction only**.

#### T1-cal3: factor from head / had / heard only (deployable)

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| A (team) | men | 98 / 100 / 86 (mean 95) | 11 / 91 / 38 (mean 47) | 8.6 |
| A (team) | women | 5 / 29 / 27 (mean 20) | 1 / 88 / 3 (mean 31) | 6.7 |
| A (team) | boys | 0 / 11 / 16 (mean 9) | 0 / 68 / 0 (mean 23) | 5.9 |
| A (team) | girls | 0 / 11 / 15 (mean 9) | 0 / 22 / 0 (mean 7) | 3.6 |
| T1-cal3 | men | 86 / 82 / 93 (mean 87) | 1 / 7 / 99 (mean 36) | 32.2 |
| T1-cal3 | women | 84 / 79 / 51 (mean 71) | 6 / 26 / 99 (mean 43) | 34.1 |
| T1-cal3 | boys | 88 / 71 / 84 (mean 81) | 4 / 0 / 98 (mean 34) | 31.9 |
| T1-cal3 | girls | 88 / 83 / 92 (mean 88) | 8 / 19 / 97 (mean 41) | 32.8 |

Centralisation (30%): median |dS| / radius 0.217 / 0.176 / 0.039; hit on centralised target 8% / 70% / 83%

#### T1: factor from all non-target, non-neighbour vowels

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| T1 | men | 86 / 77 / 93 (mean 85) | 0 / 19 / 99 (mean 39) | 32.8 |
| T1 | women | 81 / 75 / 51 (mean 69) | 4 / 22 / 99 (mean 42) | 34.2 |
| T1 | boys | 71 / 68 / 84 (mean 74) | 4 / 2 / 98 (mean 35) | 31.6 |
| T1 | girls | 88 / 89 / 92 (mean 90) | 8 / 22 / 97 (mean 42) | 33.0 |

Centralisation (30%): median |dS| / radius 0.053 / 0.028 / 0.029; hit on centralised target 7% / 56% / 82%

#### Hand-measured C1 on the same retained tokens (comparison)

| Arm | Group | Hit % (iy / ah / uw) | Neighbour FA % (iy / ah / uw) | Any-other FA % |
|---|---|---|---|---|
| C1 hand | men | 81 / 80 / 86 (mean 82) | 5 / 6 / 17 (mean 9) | 1.7 |
| C1 hand | women | 86 / 83 / 83 (mean 84) | 12 / 25 / 51 (mean 29) | 5.6 |
| C1 hand | boys | 67 / 68 / 89 (mean 75) | 13 / 0 / 24 (mean 12) | 2.2 |
| C1 hand | girls | 100 / 56 / 38 (mean 65) | 4 / 6 / 46 (mean 19) | 4.1 |

Centralisation (30%): median |dS| / radius 0.060 / 0.028 / 0.109; hit on centralised target 7% / 57% / 71%

#### Coverage: tokens with ≥3 accepted tracker frames

| Group | iy | ih | ei | eh | ae | ah | aw | oa | oo | uw | uh | er |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| men | 96 | 76 | 91 | 93 | 100 | 96 | 98 | 98 | 89 | 96 | 100 | 96 |
| women | 77 | 94 | 92 | 98 | 100 | 98 | 100 | 100 | 100 | 85 | 100 | 96 |
| boys | 89 | 74 | 89 | 93 | 96 | 100 | 96 | 100 | 89 | 77 | 100 | 96 |
| girls | 84 | 68 | 63 | 63 | 63 | 79 | 100 | 100 | 100 | 63 | 89 | 100 |

#### Instrument bias: median ln(tracker / hand), F1 / F2 (0.10 ≈ 10%)

| Group | iy | ah | uw | eh | ae | er |
|---|---|---|---|---|---|---|
| men | +0.04 / -0.01 | -0.01 / +0.01 | +0.05 / +0.04 | +0.01 / -0.01 | +0.03 / -0.02 | +0.02 / +0.02 |
| women | +0.02 / -0.00 | -0.02 / +0.01 | +0.10 / +0.16 | +0.00 / +0.01 | +0.05 / -0.03 | +0.04 / -0.04 |
| boys | +0.02 / -0.01 | -0.02 / +0.01 | +0.02 / +0.01 | +0.00 / -0.00 | +0.04 / -0.04 | +0.01 / -0.01 |
| girls | +0.00 / -0.01 | -0.04 / +0.01 | +0.00 / +0.01 | -0.02 / -0.00 | +0.04 / -0.03 | +0.01 / -0.01 |

## Amendment 3: voice sizing without the check words

Source: `vowel-mapper/research/target-scaling/results/voice-size.md`


Tokens retained: 1526. Error = |factor − all-vowel factor| in mean reference radii (ee/ah). F0/F3 are Hillenbrand hand measurements of the speaker's "uh" token.

| Method | Factor error median / 90th pct (men · women · boys · girls) | Qualifies (≤ 0.5 at 90th, all groups) | ee/ah hit % (m · w · b · g) | ee/ah neighbour FA % (m · w · b · g) |
|---|---|---|---|---|
| `cal3` | 0.12 / 0.31 · 0.19 / 0.51 · 0.15 / 0.37 · 0.17 / 0.37 | no | 87/84 · 86/77 · 90/79 · 100/80 | 1/6 · 6/24 · 2/0 · 0/19 |
| `cal3-uh` | 0.54 / 0.96 · 0.60 / 1.26 · 0.90 / 1.37 · 0.64 / 1.17 | no | 60/61 · 49/56 · 9/33 · 21/56 | 1/77 · 2/70 · 0/54 · 0/58 |
| `none` | 1.01 / 1.28 · 0.36 / 0.67 · 0.58 / 0.89 · 0.86 / 1.22 | no | 7/23 · 78/75 · 21/68 · 19/39 | 1/0 · 8/36 · 2/32 · 4/72 |
| `group` | 0.12 / 0.37 · 0.20 / 0.70 · 0.20 / 0.69 · 0.19 / 0.63 | no | 84/84 · 89/79 · 83/75 · 94/61 | 3/10 · 8/22 · 4/9 · 15/25 |
| `uh` | 0.21 / 0.50 · 0.32 / 0.69 · 0.27 / 0.69 · 0.27 / 0.51 | no | 65/84 · 73/85 · 48/59 · 93/69 | 1/5 · 7/4 · 7/4 · 14/3 |
| `f0` | 0.24 / 0.68 · 0.22 / 0.75 · 0.26 / 0.52 · 0.34 / 0.66 | no | 63/86 · 89/75 · 78/78 · 79/81 | 0/16 · 8/18 · 7/4 · 14/35 |
| `f3` | 0.36 / 0.74 · 0.34 / 0.80 · 0.21 / 0.95 · 0.17 / 0.43 | no | 49/77 · 86/75 · 61/78 · 93/62 | 1/6 · 4/27 · 2/7 · 9/26 |
| `f0f3` | 0.29 / 0.50 · 0.26 / 0.67 · 0.25 / 0.71 · 0.17 / 0.47 | no | 74/84 · 89/75 · 78/78 · 93/81 | 0/12 · 7/18 · 7/7 · 14/32 |
| `uh+group` | 0.11 / 0.38 · 0.22 / 0.55 · 0.17 / 0.41 · 0.16 / 0.40 | no | 81/86 · 92/79 · 61/74 · 100/75 | 1/3 · 8/9 · 7/0 · 14/13 |
| `group+f0f3` | 0.15 / 0.45 · 0.23 / 0.68 · 0.21 / 0.67 · 0.19 / 0.54 | no | 81/84 · 92/77 · 83/78 · 100/56 | 3/10 · 6/22 · 7/2 · 9/29 |
| `uh+group+f0f3` | 0.11 / 0.38 · 0.21 / 0.63 · 0.14 / 0.43 · 0.12 / 0.37 | no | 79/84 · 92/79 · 65/74 · 100/75 | 1/5 · 8/9 · 7/0 · 14/16 |

Qualifying pronunciation-free methods: none. Lowest worst-group 90th percentile (excluding cal3): `uh` (0.69).

Exploratory rows (uh+group, group+f0f3, uh+group+f0f3) were added after seeing the pre-registered rows. Meeting the bar: none. They need a fresh check before they count.

## The web app's fixed regions on the same tokens

Source: `vowel-mapper/research/target-scaling/web_targets.py` (regions from `web/src/vowel/targets.ts` on `main`; tracker-measured, clean, listener labels). Values are % for iy / ah / uw. Neighbours: ee ih/ei, ah aw/uh, oo oo/oa.

```
group | hit iy/ah/uw | neighbour FA iy/ah/uw
men 95 / 82 / 91 | 24 / 3 / 83
women 95 / 92 / 46 | 40 / 80 / 30
boys 33 / 71 / 53 | 22 / 68 / 2
girls 25 / 44 / 23 | 31 / 84 / 3
```
