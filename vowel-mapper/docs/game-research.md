# Personal zones support cautious visual exploration

Articulate's game is an experiment in repeating a player's own vowel zones. Research supports using acoustic displays and studying vowel movement, but **none of the sources verifies this game's scoring rules, lesson order, accessibility, or learning benefit**. The route arrows are deliberately simplified; natural words can stop short of held-vowel endpoints. Calibration uses the player's measured points, never population targets. A hit means reaching those zones, and insufficient accepted audio is reported separately. These are provisional design decisions, not a speech assessment.

Research checked October 24, 2026. This is a focused engineering review, not a systematic review. Full author/institutional papers were preferred; access limits are stated below.

## Word routes simplify the sounds they cue

Lee, Potamianos and Narayanan's study of 492 speakers reports that American English diphthong endpoints differ from nearby monophthongs. For example, /AY/ can end near /IH/ rather than held /IY/, and /AW/ near /UH/ rather than /UW/. **An ah→eee or ah→oo route is therefore a stretched game exercise, not a model of an ordinary word.** The current game retains its existing endpoint rule and labels the approximation; no new partial-travel percentage has been invented. A direction-only scoring mode needs word-level measurements before adoption. ([Lee et al., 2014, full author paper](https://sail.usc.edu/span/pdfs/lee2014developmental.pdf))

Hillenbrand's description of southern Michigan English documents dialect-dependent vowel geometry, including /æ/ raising/fronting and /ɛ/ lowering, and treats /w/ as an approximant. This supports personal calibration and cautions against a universal ladder or equating /w/ with an isolated oo vowel. ([Hillenbrand, 2003](https://www.cambridge.org/core/services/aop-cambridge-core/content/view/5A8CECE6958DD48F85113A210E6554F4/S0025100303001221a.pdf/american-english-southern-michigan.pdf))

| Lesson | Claim and evidence status | Shipped interpretation |
| --- | --- | --- |
| Calibration: eee / ah / oo | Speaker/dialect variation is **verified**; this game's median, radius and sample-count rules are **unvalidated**. [Hillenbrand](https://doi.org/10.1017/S0025100303001221) | Capture each comfortable held sound. Insufficient or indistinct zones fail visibly. |
| First route and front–back sweep | Vowel contrasts are **verified**; oo→eee for “we” is an **approximation**, not detection of /w/. [Hillenbrand](https://doi.org/10.1017/S0025100303001221), [ASHA contrast definition](https://www.asha.org/practice-portal/clinical-topics/articulation-and-phonology/) | We, key/coo and tea/two are word prompts; consonant letters are unjudged cues. |
| Hi/buy, how/now | Dynamic-vowel rationale is **verified**; exact held-zone endpoints are **not supported as natural-word targets**. [Lee et al.](https://doi.org/10.1121/1.4894799) | Explicitly stretched routes. “Now” warns that nasal humming can still move the dot. |
| Boy | Diphthong rationale is **verified**; an isolated aw-like anchor is an **approximation**. [Lee et al.](https://doi.org/10.1121/1.4894799) | Capture aw and eee as a separate set; never substitute ah. |
| Beat/bit/bet/bat | Distinct vowel categories are **verified**; a universal geometric height order is **unverified**. [Hillenbrand](https://doi.org/10.1017/S0025100303001221) | Capture eee, ih, eh and a individually. No interpolation or required spatial order. |
| Rent/ween | This is **not a minimal pair** in the intended English reading: onset, vowel and final /t/ differ. F1/F2 cannot establish r/w. [ASHA](https://www.asha.org/practice-portal/clinical-topics/articulation-and-phonology/), [Harper et al.](https://doi.org/10.1121/10.0001413) | Locked: no nasal rejection rule passed the project's acceptance criterion. Passing such a rule would still not validate consonant scoring. |

Extra lessons retain independent calibration sets. Measuring another eee for boy or the front-vowel set cannot move a previously calibrated base target. Redoing the base warm-up clears extras. Holds, timing windows and endpoint counts remain **provisional game parameters**, without demonstrated perceptual or educational meaning.

## Historical measurements do not prescribe a player's targets

Osberger and McGarr's 1982 review, printed p.240, attributes a relatively stationary F2 around 1800 Hz to Monsen's 1976 vowel study. The retrieved passage does **not** establish the draft's 1500–1800-Hz range or a universal characteristic of deaf speakers. The narrower attribution is verified in the review only; Monsen's original full paper was unavailable. ([Review manuscript scan](https://successforkidswithhearingloss.com/wp-content/uploads/2013/01/Speech-Production-Characteristics-article.pdf), [original paper record](https://www.sciencedirect.com/science/article/pii/S0095447019312434))

A fixed “r means F3 below 1800 Hz” rule is contradicted by Harper, Goldstein and Narayanan's six-speaker study: three reported speaker means exceed 1800 Hz. The authors also describe failures of automatic F3 measurement when F2 and F3 are close. Articulate has no validated F3 feature or r/w classifier. ([Harper et al., 2020, Table I and methods](https://sail.usc.edu/span/pdfs/harper2020variability.pdf))

## Visual feedback is a rationale for study

A small study of ten Czech learners of Swedish combined ultrasound and acoustic formant feedback across three sessions. Outcomes varied by learner and target; the researchers manually selected acoustic measurements to avoid nasal/formant tracking errors. That supports investigating visual feedback while emphasizing the limits of automatic measurements. It does not establish benefit for this game, deaf users, or unattended noisy-hall use. ([Kocjančič, Bořil and Hofmann, online 2024 / issue 2025](https://fu.ff.cuni.cz/obd/647525.pdf))

The Ling/LMH sounds are used in listening checks, including detection, discrimination and identification of presented sounds. The John Tracy Center procedure is not a formant-based speech-production assessment. Articulate must not be called a Ling Six test merely because some example sounds overlap. ([John Tracy Center handout](https://jtcorg-media-library.s3.amazonaws.com/wp-content/uploads/2023/09/26115155/LING-10-Handout.pdf))

The next meaningful validation is with intended users and real microphones: can they understand zone-only outcomes, set repeatable targets comfortably, and follow the visual timing? Synthetic browser tests demonstrate software behavior; they do not answer those questions or establish transfer to everyday speech.
