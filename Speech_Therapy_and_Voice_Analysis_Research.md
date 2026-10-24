# Speech Therapy Persona & Backend Voice Sample Analysis Research

This document consolidates the three research streams for the **Visual Speech Coach**:
1. **Part I — Clinical Speech Therapy Session Structure & Agent Persona Tuning:** How actual speech-language pathology (SLP) sessions are structured (Motor Learning Theory, Speech Motor Chaining, Visual-Acoustic Biofeedback, and ASHA DHH guidelines) and how to tune our agent's persona and prompts.
2. **Part II — Backend Voice Sample Analysis & Target Comparison:** What acoustic, temporal, voice-quality, prosodic, and neural analyses the backend can perform on a learner's voice sample to compare it against a target reference voice sample.
3. **Part III — Microphone Hardware & Acoustic Capture Setup:** What microphone hardware, physical placement, and Web Audio settings work best for simultaneous `praat-parselmouth` acoustic measurement and `MediaPipe` lip/jaw tracking.

---

# Part I: Clinical Speech Therapy Session Structure & Agent Persona Tuning

## 1. Roadmap Alignment: Core Constraints on the Persona

From [Visual_Speech_Coach_Roadmap.md](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L9-L41) and Section 5 ([Coaching behavior and evidence](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L152-L173)), the agent persona must operate within strict clinical and technical boundaries:

1. **Audience & Communication Autonomy:** Serve Deaf and Hard-of-Hearing (DHH) learners who choose to practice spoken communication as guided practice between professional sessions. The learner controls audio, pacing, and assistance; every spoken turn must have an exact, readable visual caption.
2. **Evidence-Grounded Honesty:**
   - Acoustic formants ($F_1, F_2$) measure vocal-tract resonance, **not** direct tongue or throat coordinates. Never claim what the learner's tongue did (`"your tongue stayed back"` is forbidden).
   - Visible articulators (lips, jaw) may only be described as observations when backed by usable MediaPipe camera telemetry (`video.verdict != "insufficient"`).
   - Poor audio/video capture is a **technical capture repair**, never a pronunciation failure.
3. **Delivery Style:** Consistent voice, calm instructions, **restrained praise** (avoiding hollow cheerleading), short turns (1–3 brief sentences), and zero emotion inference from facial landmarks.

---

## 2. How Actual Speech Therapy Sessions Are Structured

Evidence-based articulation and biofeedback sessions—specifically **Speech Motor Chaining** (Preston et al., 2019), **Visual-Acoustic Biofeedback (VAB)** (Hitchcock et al., 2023), and **ChainingAI** (Benway & Preston, 2024)—are structured around **Principles of Motor Learning (PML)** rather than passive "repeat-after-me" drills. A clinical session progresses through five distinct phases:

```
┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐   ┌──────────────────┐
│ 1. Goal & Check  │──▶│ 2. Pre-Practice  │──▶│ 3. Guided Block  │──▶│ 4. Faded / Xfer  │──▶│ 5. Metacognitive │
│ (Autonomy/Setup) │   │ (Stimulability & │   │ (High KP -> KR,  │   │ (Target Hidden / │   │    Wrap-Up       │
│                  │   │  Baseline Probe) │   │  Single Cue)     │   │  New Context)    │   │ (Learner Choice) │
└──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘   └──────────────────┘
```

### Phase 1: Connection, Readiness & Shared Agenda (1–2 turns)
* **What SLPs actually do:** Before any drill, the clinician checks communication access (captions, audio preference, camera framing) and co-establishes the session plan with the client rather than dictating commands.
* **Roadmap mapping ([Section 1](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L34-L36), [Section 5](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L164)):** *"Would you like to watch first or try it yourself?"*
* **Persona implication:** Frame the opening turn as an invitation with clear expectations (e.g., naming the 1–2 target vowels for today and offering the 3D cutaway reference first).

### Phase 2: Pre-Practice — Exploratory Mapping & Unassisted Baseline Probe
* **What SLPs actually do (Hitchcock et al., 2023; Preston et al., 2019):**
  * In **Visual-Acoustic Biofeedback (VAB)**, the learner first explores how physical mouth movements move the visual cursor on screen without being graded.
  * Next, the clinician collects an **unassisted baseline probe** (*"Try it once on your own so we can see where your sound starts"*) before layering on corrective cues.
* **Why this matters for DHH learners:** Without a typical auditory loop, DHH learners build an **internal somatosensory + visual map** (linking how their jaw/lips feel to where the $F_1/F_2$ dot lands).
* **Persona implication:** Never criticize the first attempt. Treat the baseline attempt as calibration and discovery (*"That gives us a clear starting point on the chart"*).

### Phase 3: Structured Practice Blocks (Managing Cognitive Load)
* **What SLPs actually do (Preston et al., 2019):**
  * Practice happens in short, contiguous **blocks** (typically 3–6 trials per block on the same target) so the learner can test a physical adjustment across comparable retries.
  * **One Cue at a Time (Hitchcock et al., 2023):** Clinicians never stack multiple biomechanical instructions in one turn (e.g., telling a learner to change tongue height, lip rounding, and jaw opening simultaneously causes motor overload). They pick **one concrete cue**, let the learner try it for 2–3 attempts, and if acoustic distance does not improve across the block, **switch to an alternative cue modality** (`change_cue`).
* **Persona implication:** Keep retry prompts short so the learner stays focused on their motor memory from the attempt that just finished, rather than reading a paragraph of text between trials.

### Phase 4: Fading Scaffolding & Transfer (`reduce_assistance` / `independent`)
* **What SLPs actually do:** Moving the cursor into a target box while staring at the screen proves *guided task performance*, not *motor retention*. If a clinician gives constant visual overlays and detailed instructions after every trial, the learner becomes dependent on external feedback.
* **Clinical transition:** After 2–3 consecutive on-target guided trials, the SLP intentionally **fades the scaffold**—hiding the target overlay or asking for one independent production while keeping communication access (captions) intact. If the learner slips outside the region when the guide is hidden, the SLP calmly restores the guide (`simplify`) without framing it as a setback.

### Phase 5: Fatigue Management & Metacognitive Agency (`rest` / `pause`)
* **What SLPs actually do:** High-effort motor speech practice is physically and cognitively tiring. When a client misses several trials in a row or reports `"too-hard"`, an SLP never pushes repetitive failing drills (which reinforces the wrong motor pathway). Instead, they pivot: offer a breather, step down difficulty, or switch to a contrasting vowel so the learner ends on a successful movement.

---

## 3. Clinical Communication Principles for Tuning the Persona

### 3.1 Knowledge of Performance (KP) vs. Knowledge of Results (KR)

Motor learning literature divides clinician feedback into two distinct types that must shift across a session:

| Feedback Type | Clinical Definition | When SLPs Use It | How Our Agent Should Phrase It |
| :--- | :--- | :--- | :--- |
| **Knowledge of Performance (KP)** | Specific feedback about *how* the movement was executed or *how* to adjust articulators. | **Early attempts / Off-target retries:** When the learner is outside the target region and needs an actionable adjustment. | *Grounded in CV or Target Reference:*<br>• With CV (`video.verdict == "partly"`): *"The camera saw your lips stay wide. Round your lips forward a little more for oo."*<br>• Without CV (Target Reference KP): *"Watch the side view: for ee, spread the corners of your lips gently."* |
| **Knowledge of Results (KR)** | Outcome feedback on *where* the sound landed relative to the goal, without over-explaining mechanics. | **Closer / On-target / Faded trials:** When the learner is improving or practicing with reduced assistance, to build internal self-monitoring. | *Grounded in Acoustic Cursor:*<br>• *"Your oo landed right inside the target area."*<br>• *"That try moved closer to the target box than your last one. Try that same feel once more."* |

### 3.2 Internal vs. External / Somatosensory Focus of Attention
Research on oral-motor learning (Wulf; ASHA PML guidelines) shows that constant **internal anatomical commands** (*"Position your mandible low and retract your lingual body"*) cause hyper-monitoring and stiff, unnatural speech. Effective SLPs blend:
1. **Visible Anchor Cues (Concrete & Externalizable):** *"Spread your lips like a gentle smile"*, *"Round your lips into a small circle"*, *"Let your jaw drop open and relaxed."*
2. **Visual-Cursor Cues (External Focus):** Connecting the learner's voice to the screen effect—*"Hold that steady voice and keep the dot inside the target ring."*
3. **Proprioceptive / Kinesthetic Anchoring (Critical for DHH Learners):** Because DHH learners rely heavily on tactile/kinesthetic feedback to carry speech over outside the app, SLPs use **feeling anchors** after a good or improved trial: *"Notice how your lips and jaw felt on that try, and do one more just like it."*

### 3.3 Restrained, Descriptive Praise vs. Empty Cheerleading
In [Visual_Speech_Coach_Roadmap.md](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L170), the specification explicitly calls for **restrained praise**:
* **Avoid (Robotic / Pediatric Cheerleading):** *"Amazing job!! You did fantastic! Keep up the awesome work!"*
* **Use (Descriptive Clinical Reinforcement):** *"Nice and steady—your ah stayed inside the target area."* / *"Good adjustment. Let's do one more to lock that in."*

### 3.4 Concrete Codebase Persona Tuning Opportunities

| Area | Current Behavior | Clinical SLP Upgrade | Target File |
| :--- | :--- | :--- | :--- |
| **1. KP vs. KR Differentiation** | [`COACH_SYSTEM`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py#L41-L51) tells Claude to "be encouraging and specific" without distinguishing biomechanical KP from outcome KR. | Instruct `COACH_SYSTEM` to give 1 placement cue (KP) when `off`, directional adjustment when `close`, and calm KR + kinesthetic feel-anchoring when `on_target`. | [`llm.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py#L41-L51), [`decision.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/decision.py#L134-L164) |
| **2. Avoiding the `offsetMeaning` Tongue Trap** | [`orchestrator.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/orchestrator.py#L120) defines `f1Offset` as `"more open / lower tongue"`, tempting the LLM to mention the learner's tongue and fail [`validate_decision`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/decision.py#L108-L109). | Describe `f1Offset` / `f2Offset` in acoustic/chart terms (*"more open sound / lower on the vowel chart"*), never as a claim about the learner's tongue. | [`orchestrator.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/orchestrator.py#L120) |
| **3. Somatosensory Anchoring** | Scripted retry lines in [`talk_prompts.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/talk_prompts.py#L33-L39) are generic (*"Whenever you're ready, try it again"*). | Blend calm pacing with kinesthetic awareness while respecting all regex guardrails in [`session.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/session.py). | [`talk_prompts.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/talk_prompts.py#L3-L44) |
| **4. Restrained Praise** | Prompts say `"Be encouraging"`, encouraging generic filler praise even on misses. | Specify a *"calm, collaborative, matter-of-fact coaching tone with restrained, descriptive praise."* | [`talk_prompts.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/talk_prompts.py#L3-L18), [`llm.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py#L41-L58) |

---

# Part II: Backend Voice Sample Analysis & Target Comparison

## 1. Current Audio Analysis Baseline vs. What Is Missing

Right now, the repository contains two separate audio analysis paths that do not yet work together for full vowel-to-reference sample comparison:

1. **Live Vowel Scoring ([`scoring.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/scoring.py#L34-L61), [`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py#L69-L109)):**
   * Extracts frame-by-frame $F_1, F_2, F_0$ via `parselmouth` Burg LPC (`To Formant (burg)`).
   * Collapses the entire attempt into static summary statistics (`f1Median`, `f2Median`, `inTargetFraction`, `f1Offset`, `f2Offset`, IQR `spread`) and compares them against **hardcoded, unnormalized Hz centers** (`i`: $390/2500\text{ Hz}$, `u`: $420/1050\text{ Hz}$, `a`: $850/1400\text{ Hz}$).
   * **What it misses:** It never analyzes the *target reference audio sample* itself, does not normalize for speaker vocal-tract length (penalizing children, women, or deep-voiced speakers), ignores *temporal drift* (onset vs. steady nucleus vs. offglide), and ignores *voice quality/resonance* (breathiness, vocal strain, nasality).
2. **Intonation / Pitch Contour Comparison ([`extract.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/extract.py), [`compare.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/compare.py)):**
   * Compares a learner's waveform against a reference waveform using median-normalized semitone contours ($12 \log_2(F_0 / \text{median}(F_0))$) and Sakoe-Chiba constrained Dynamic Time Warping (DTW), but **only looks at $F_0$ pitch**, ignoring formants, spectral balance, and phonation quality. Furthermore, [`ContentVerifier`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/content.py#L19-L25) is currently a stub (`not_configured`).

---

## 2. Five Tiers of Backend Voice Comparison (Learner vs. Target Sample)

To give the coaching agent deep, clinically actionable insight when comparing a learner's recording $x_{\text{learn}}(t)$ against a target reference recording $x_{\text{ref}}(t)$, the backend can run a **five-tier analysis pipeline** in ~15–40 ms on CPU (Tiers 1–4 via `praat-parselmouth` + `numpy`) plus optional neural comparison (Tier 5):

```
Learner Sample x_learn(t) ──┐   ┌──────────────────────────────────────────────────────────┐
                            ├──▶│ Tier 1: Speaker-Independent Formant Normalization (Bark) │
Target Sample  x_ref(t)   ──┘   │ Tier 2: 3-Phase Trajectory & Multivariate DTW Alignment  │
                                │ Tier 3: Phonation, Voice Effort & Nasality (Parselmouth) │
                                │ Tier 4: Prosodic & Energy Envelope Comparison            │
                                │ Tier 5: SSL Phonetic Posteriors / SPARC Inversion (Opt.) │
                                └───────────────────────────┬──────────────────────────────┘
                                                            ▼
                                     Structured Evidence Payload -> Claude Coach Agent
```

---

### Tier 1: Speaker-Independent Vowel Space Normalization (Solving Vocal-Tract Length)

#### Why Raw Hz Comparison Fails
Absolute formant frequencies scale inversely with **Vocal Tract Length (VTL)**:

$$F_n \approx \frac{(2n - 1)c}{4 L_{\text{tract}}}$$

An adult male ($L \approx 17.5\text{ cm}$), an adult female ($L \approx 14.5\text{ cm}$), and a child ($L \approx 11\text{ cm}$) producing the exact same vowel `/i/` will have $F_1$ and $F_2$ shifted by up to $30\text{–}50\%$. Comparing a learner's raw Hz directly to a Cartesia TTS reference sample or fixed Hz ellipse creates false errors.

#### Backend Solution: Intrinsic $F_3$-Anchored Bark-Difference & Log-Ratio Comparison
In acoustic phonetics (Syrdal & Gopal, 1986; Hitchcock et al., 2023), the third formant ($F_3$) for non-rhotic vowels (`/i/`, `/u/`, `/ɑ/`) primarily reflects **speaker vocal-tract length** rather than vowel identity. By extracting $F_1, F_2, F_3$ from *both* the target reference sample and the learner sample, we can normalize without requiring a multi-vowel calibration session:

1. **Auditory Bark Transformation (Traunmüller formula):**
   Convert each formant $f_k$ (for $k \in \{1, 2, 3\}$) from Hz into critical-band **Bark** units ($Z_k$):

   $$Z_k = \frac{26.81 \cdot f_k}{1960 + f_k} - 0.53$$

2. **Speaker-Normalized Bark Coordinates:**
   Compute the intrinsic vocal-tract-normalized coordinates for both the reference sample ($\text{ref}$) and learner sample ($\text{learn}$):
   * **Openness / Height Dimension:** $D_{\text{open}} = Z_3 - Z_1$ (high for close vowels `/i/, /u/`; low for open vowel `/ɑ/`)
   * **Frontness / Rounding Dimension:** $D_{\text{front}} = Z_3 - Z_2$ (low for front unrounded `/i/`; high for back rounded `/u/`)
   * **Scale-Invariant Log-Ratios:** $R_{13} = \ln(F_1 / F_3)$ and $R_{23} = \ln(F_2 / F_3)$

3. **Adaptive Formant Ceiling Selection (`maximum_formant`):**
   Praat's Burg LPC requires a speaker-appropriate `maximum_formant` ceiling ($5000\text{ Hz}$ for low adult male voices, $5500\text{ Hz}$ for adult female/mid voices, $6000\text{–}6200\text{ Hz}$ for children). The backend can automatically select `maximum_formant` per sample by conditioning on the speaker's median fundamental frequency ($F_0$).

| Metric Field | What It Compares | Coaching Insight Enabled |
| :--- | :--- | :--- |
| **`bark_distance_to_target`** | Euclidean distance in normalized $(Z_3 - Z_1, Z_3 - Z_2)$ space between learner nucleus and target sample nucleus. | Accurately grades vowel quality across any age/sex without penalizing shorter or longer vocal tracts. |
| **`openness_delta_bark`** | $(Z_3 - Z_1)_{\text{learn}} - (Z_3 - Z_1)_{\text{ref}}$ | Isolates whether the learner's oral cavity is **too open** or **too closed** relative to the reference speaker. |
| **`frontness_delta_bark`** | $(Z_3 - Z_2)_{\text{learn}} - (Z_3 - Z_2)_{\text{ref}}$ | Isolates whether resonance is **too far forward/spread** or **too far back/rounded** relative to the reference. |

---

### Tier 2: Temporal Formant Dynamics & Trajectory Alignment (Onset $\rightarrow$ Nucleus $\rightarrow$ Offglide)

#### Why Static Medians Are Insufficient
Collapsing a 1.5-second vowel attempt into a single `f1Median` / `f2Median` hides *how* the learner produced the sound:
* Did the learner **search** for the vowel during the first 400 ms and finally lock it in at the end?
* Did the learner **start on target** and then let their lip rounding or jaw drop collapse halfway through (`offglide drift`)?
* Did the learner accidentally diphthongize a steady monophthong (e.g., turning `/u/` into `[əʊ]` or `/i/` into `[ɪi]`)?

#### Backend Solution: 3-Phase Segmentation & Trajectory DTW
Given the voiced frames $t_1, \dots, t_N$ of the learner sample and $t'_1, \dots, t'_M$ of the target sample:

1. **Three-Phase Vowel Segmentation:**
   Partition the voiced span $[t_{\text{start}}, t_{\text{end}}]$ into:
   * **Onset ($0\text{–}20\%$):** Articulatory attack / target acquisition.
   * **Nucleus ($20\text{–}80\%$):** Core sustained vowel target (used for primary accuracy scoring so onset/offset transients don't skew the mean).
   * **Offglide ($80\text{–}100\%$):** Release stability.

2. **Trajectory Slope & Diphthongization Index (Vector Length / Spectral Change):**
   Compute the **Trajectory Vector Length (TVL)** in Bark space across the vowel hold:

   $$\text{TVL}_{\text{bark}} = \sqrt{\left(\Delta(Z_3 - Z_1)_{20\to 80}\right)^2 + \left(\Delta(Z_3 - Z_2)_{20\to 80}\right)^2}$$

   * Comparing `onset_distance` vs. `nucleus_distance` vs. `offglide_distance` tells the agent whether the learner **converged toward** the target (`converging`), **drifted away** (`fading_hold`), or stayed **steady** (`stable_hold`).

3. **Multivariate Formant-Trajectory DTW (`formant_dtw_rmse_bark`):**
   Using the same band-constrained Sakoe-Chiba DTW already in [`compare.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/compare.py#L112-L132), align the learner's 2D normalized formant curve $\mathbf{z}_{\text{learn}}(t) = [Z_3-Z_1, Z_3-Z_2]$ against the target sample's curve $\mathbf{z}_{\text{ref}}(t)$.

---

### Tier 3: Phonation, Voice Quality, Vocal Effort & Nasality (`parselmouth` Deep Extraction)

#### Why Voice Quality Matters for DHH Learners
Reduced auditory feedback often causes secondary phonation and resonance habits when learners concentrate on hitting a vowel target:
1. **Pressed / Strained Voice (Hyperadduction):** Pushing too hard from the larynx when trying to project a sound.
2. **Breathy / Weak Phonation (Hypoadduction):** Incomplete vocal fold closure, leaking air and reducing harmonic clarity.
3. **Unintended Hypernasality (Velopharyngeal Laxity):** Letting the velum (soft palate) drop during oral vowels (`/i/`, `/u/`, `/ɑ/`), which damps $F_1$ and couples nasal antiresonances.

All of these can be computed directly in Python via `praat-parselmouth` on the vowel nucleus and compared against the target reference sample:

| Acoustic Feature | Praat / Parselmouth Extraction Method | What Learner vs. Target Comparison Reveals |
| :--- | :--- | :--- |
| **Harmonics-to-Noise Ratio (`hnr_db`)** | `sound.to_harmonicity_cc(time_step=0.01, minimum_pitch=75)` $\rightarrow$ mean dB over nucleus | Target reference speech typically has $\text{HNR} \in [15, 25]\text{ dB}$. A low learner HNR ($< 10\text{ dB}$) indicates **breathy or noisy voicing** rather than a clear tone. |
| **Cepstral Peak Prominence (`cpp_db`)** | `call(sound, "To PowerCepstrogram", 60.0, 0.002, 5000.0, 50.0)` $\rightarrow$ `Get CPPS` | Gold-standard ASHA clinical metric for overall **voice periodicity and clarity**, robust even when pitch tracking is noisy. |
| **Glottal Effort / Spectral Tilt (`h1_h2_db`, `spectral_tilt_db`)** | Amplitude of 1st harmonic ($f_0$) minus 2nd harmonic ($2f_0$) from narrowband spectrum, plus spectral slope $[0\text{–}1\text{ kHz}]$ vs. $[1\text{–}4\text{ kHz}]$. | • **High `h1_h2_db` ($> +6\text{ dB}$ vs. target):** Soft, breathy voice.<br>• **Low/Negative `h1_h2_db` ($< -4\text{ dB}$ vs. target):** Tense, pressed, strained voice (*"Try relaxing your throat and using a gentler voice"*). |
| **First Formant Bandwidth & Nasality Proxy (`b1_hz`, `b1_ratio`)** | `formants.get_bandwidth_at_time(1, t)` compared to reference $B_1$. | Nasal coupling and breathy damping sharply widen the bandwidth of $F_1$ ($B_1 > 250\text{ Hz}$ on high vowels `/i/, /u/`). Flags when nasalization or damping is blurring the vowel peak. |
| **Cycle-to-Cycle Stability (`jitter_local_pct`, `shimmer_local_db`)** | `call([sound, point_process], "Get jitter (local)", ...)` and `"Get shimmer (local_dB)"` on steady nucleus ($\ge 300\text{ ms}$). | Detects micro-instability in vocal fold vibration during sustained vowel holds. |

---

### Tier 4: Prosodic, Pitch & Intensity Envelope Comparison

1. **Pitch Stability & Intonation Match (`f0_iqr_st`, `aligned_pitch_rmse_st`):**
   * Unify the pitch contour extractor in [`extract.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/extract.py) with the vowel analyzer so every vowel attempt also reports **semitone steadiness** ($\text{IQR of } 12 \log_2(F_0 / \text{median}(F_0))$).
   * If a learner's pitch wavers wildly ($\text{IQR} > 3.5\text{ st}$) during a sustained vowel task, LPC formant estimates can jump as harmonics cross formant peaks; the coach can gently cue *"Hold a steady, comfortable note."*
2. **Intensity Envelope & Attack/Decay Shape (`intensity_std_db`, `intensity_drop_db`):**
   * Extracted via `sound.to_intensity(minimum_pitch=75)`.
   * Measures whether the learner maintained steady breath support across the vowel nucleus or faded out immediately after onset (`intensity_drop_db < -8 dB` from onset to offglide).
3. **Duration & Speaking Rate Ratio (`voiced_duration_ratio`):**
   * Ratio of learner usable voiced duration to target reference voiced duration ($T_{\text{learn}} / T_{\text{ref}}$), distinguishing clipped/rushed productions ($< 0.45\times$) from sustained holds.

---

### Tier 5: Neural Phonetic & Articulatory Comparison (Stretch / High-Precision Tier)

1. **Lightweight Phonetic Posteriorgrams / Goodness of Pronunciation (GOP) for [`ContentVerifier`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/content.py):**
   * Using an ONNX-quantized `wav2vec2-base` / `HuBERT` / `Allosaurus` phone recognizer (~30 ms on CPU for a 1.5 s clip), extract frame-level phoneme posteriors $P(\phi \mid x)$ for both the target sample and learner sample:
     * **Target Posterior Score:** Mean posterior probability $P(\text{target\_vowel} \mid x_{\text{learn}})$ over the voiced nucleus.
     * **Competing Phoneme Detection (`nearest_competing_phone`):** Identifies *which* vowel the learner's sample sounded closest to if off-target (e.g., Target `/i/` heard as lax `/ɪ/` or `/e/`, or Target `/u/` heard as centralized `/ʊ/` or `/ə/`).
2. **SSL Layer-Wise Cosine Similarity (WavLM / HuBERT Mid-Layers):**
   * Intermediate transformer layers (layers 6–9 of `WavLM-Base+` or `HuBERT-Base`) encode **speaker-invariant phonetic structure** while stripping out speaker identity and room acoustics. DTW-aligned cosine similarity between $\mathbf{h}_{\text{learn}}^{(l)}$ and $\mathbf{h}_{\text{ref}}^{(l)}$ yields a single calibration-free pronunciation match score in $[0, 1]$.
3. **SPARC Articulatory Inversion Comparison ([Roadmap Section 4](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L131)):**
   * Passing both $x_{\text{ref}}(t)$ and $x_{\text{learn}}(t)$ through **SPARC** outputs 12 normalized EMA articulatory features (lip aperture, lip protrusion, jaw, tongue tip/blade/dorsum $X/Y$). Comparing the two inverted trajectories provides an *Estimated Articulation Delta* (kept strictly separate from measured acoustics/video per Roadmap rules).

---

## 3. Reference Python Implementation (`parselmouth` + `numpy`)

```python
from dataclasses import dataclass
import math
import numpy as np
import parselmouth
from parselmouth.praat import call


def hz_to_bark(f_hz: float) -> float:
    """Traunmuller critical-band rate (Bark) transformation."""
    return (26.81 * f_hz) / (1960.0 + f_hz) - 0.53


@dataclass(frozen=True)
class VoiceSampleProfile:
    usable_voiced_s: float
    f0_median_hz: float | None
    f0_iqr_st: float | None
    # Nucleus medians (20%-80% voiced span)
    f1_nucleus_hz: float | None
    f2_nucleus_hz: float | None
    f3_nucleus_hz: float | None
    b1_nucleus_hz: float | None
    # Speaker-normalized Bark-difference coordinates
    openness_bark: float | None      # Z3 - Z1 (smaller = more open jaw/mouth)
    frontness_bark: float | None     # Z3 - Z2 (smaller = further front / spread)
    # Temporal trajectory dynamics (onset -> nucleus -> offglide)
    trajectory_drift_bark: float | None
    onset_to_nucleus_shift_bark: float | None
    # Voice quality & intensity envelope
    hnr_mean_db: float | None
    cpp_db: float | None
    intensity_drop_db: float | None


def analyze_voice_sample(samples: np.ndarray, sample_rate: int) -> VoiceSampleProfile:
    """Extract speaker-normalized formants, trajectory dynamics, and voice quality."""
    sound = parselmouth.Sound(samples.astype(np.float64), sampling_frequency=sample_rate)
    pitch = sound.to_pitch_ac(time_step=0.01, pitch_floor=75.0, pitch_ceiling=600.0)
    f0_values = pitch.selected_array["frequency"]
    voiced_idx = np.flatnonzero(f0_values > 0)

    if voiced_idx.size < 8:
        return VoiceSampleProfile(
            usable_voiced_s=voiced_idx.size * 0.01,
            f0_median_hz=None, f0_iqr_st=None,
            f1_nucleus_hz=None, f2_nucleus_hz=None, f3_nucleus_hz=None, b1_nucleus_hz=None,
            openness_bark=None, frontness_bark=None,
            trajectory_drift_bark=None, onset_to_nucleus_shift_bark=None,
            hnr_mean_db=None, cpp_db=None, intensity_drop_db=None,
        )

    f0_voiced = f0_values[voiced_idx]
    f0_med = float(np.median(f0_voiced))
    st_voiced = 12.0 * np.log2(f0_voiced / f0_med)
    f0_iqr_st = float(np.percentile(st_voiced, 75) - np.percentile(st_voiced, 25))

    # Adaptive formant ceiling based on speaker fundamental frequency
    ceiling = 5000.0 if f0_med < 165.0 else (5500.0 if f0_med < 255.0 else 6200.0)
    formants = sound.to_formant_burg(
        time_step=0.01, max_number_of_formants=5, maximum_formant=ceiling,
        window_length=0.025, pre_emphasis_from=50.0,
    )
    harmonicity = sound.to_harmonicity_cc(time_step=0.01, minimum_pitch=75.0)
    intensity = sound.to_intensity(minimum_pitch=75.0, time_step=0.01)

    times = [pitch.get_time_from_frame_number(int(i) + 1) for i in voiced_idx]
    tracks: list[tuple[float, float, float, float, float, float]] = []
    for t in times:
        f1 = formants.get_value_at_time(1, t)
        f2 = formants.get_value_at_time(2, t)
        f3 = formants.get_value_at_time(3, t)
        b1 = formants.get_bandwidth_at_time(1, t)
        hnr = harmonicity.get_value(t)
        db = intensity.get_value(t)
        if all(math.isfinite(x) and x > 0 for x in (f1, f2, f3, b1)) and f1 < f2 < f3:
            tracks.append((
                f1, f2, f3, b1,
                hnr if math.isfinite(hnr) and hnr > -50 else float("nan"),
                db if math.isfinite(db) else float("nan"),
            ))

    if len(tracks) < 6:
        return VoiceSampleProfile(
            usable_voiced_s=len(tracks) * 0.01,
            f0_median_hz=round(f0_med, 1), f0_iqr_st=round(f0_iqr_st, 2),
            f1_nucleus_hz=None, f2_nucleus_hz=None, f3_nucleus_hz=None, b1_nucleus_hz=None,
            openness_bark=None, frontness_bark=None,
            trajectory_drift_bark=None, onset_to_nucleus_shift_bark=None,
            hnr_mean_db=None, cpp_db=None, intensity_drop_db=None,
        )

    arr = np.asarray(tracks, dtype=np.float64)
    n = len(arr)
    # 3-phase split: onset [0:20%], nucleus [20%:80%], offglide [80%:100%]
    i_20, i_80 = max(1, int(0.2 * n)), min(n - 1, max(2, int(0.8 * n)))
    onset, nucleus, offglide = arr[:i_20], arr[i_20:i_80], arr[i_80:]

    f1_nuc, f2_nuc, f3_nuc, b1_nuc = (float(np.median(nucleus[:, k])) for k in range(4))
    z1, z2, z3 = hz_to_bark(f1_nuc), hz_to_bark(f2_nuc), hz_to_bark(f3_nuc)
    open_nuc, front_nuc = z3 - z1, z3 - z2

    def phase_bark(seg: np.ndarray) -> tuple[float, float]:
        zf1, zf2, zf3 = (hz_to_bark(float(np.median(seg[:, k]))) for k in range(3))
        return zf3 - zf1, zf3 - zf2

    open_on, front_on = phase_bark(onset)
    open_off, front_off = phase_bark(offglide)
    onset_shift = math.hypot(open_nuc - open_on, front_nuc - front_on)
    drift = math.hypot(open_off - open_nuc, front_off - front_nuc)

    hnr_clean = nucleus[~np.isnan(nucleus[:, 4]), 4]
    hnr_mean = float(np.mean(hnr_clean)) if hnr_clean.size else None

    db_on = onset[~np.isnan(onset[:, 5]), 5]
    db_off = offglide[~np.isnan(offglide[:, 5]), 5]
    db_drop = float(np.median(db_off) - np.median(db_on)) if (db_on.size and db_off.size) else None

    try:
        cepstrogram = call(sound, "To PowerCepstrogram", 60.0, 0.002, 5000.0, 50.0)
        cpp_val = float(call(cepstrogram, "Get CPPS", False, 0.02, 0.0005, 60.0, 330.0, 0.05, "Parabolic", 0.001, 0.0, "Exponential decay", "Robust"))
    except Exception:
        cpp_val = None

    return VoiceSampleProfile(
        usable_voiced_s=round(n * 0.01, 2),
        f0_median_hz=round(f0_med, 1),
        f0_iqr_st=round(f0_iqr_st, 2),
        f1_nucleus_hz=round(f1_nuc, 1),
        f2_nucleus_hz=round(f2_nuc, 1),
        f3_nucleus_hz=round(f3_nuc, 1),
        b1_nucleus_hz=round(b1_nuc, 1),
        openness_bark=round(open_nuc, 3),
        frontness_bark=round(front_nuc, 3),
        trajectory_drift_bark=round(drift, 3),
        onset_to_nucleus_shift_bark=round(onset_shift, 3),
        hnr_mean_db=round(hnr_mean, 1) if hnr_mean is not None else None,
        cpp_db=round(cpp_val, 1) if cpp_val is not None and math.isfinite(cpp_val) else None,
        intensity_drop_db=round(db_drop, 1) if db_drop is not None else None,
    )
```

---

## 4. Mapping Backend Comparison Evidence to Coaching Feedback

| Backend Comparison Finding | Code Condition (Learner vs. Target Sample) | What the Agent Can Safely Tell the Learner |
| :--- | :--- | :--- |
| **Speaker-Normalized Match** | `bark_distance <= 1.0` (even if raw Hz differs due to pitch/VTL) | *"Your vowel resonance matched the target cleanly for your voice."* |
| **Onset Search $\rightarrow$ Late Lock-in (`converged_late`)** | `onset_distance > 1.5` and `nucleus_distance <= 1.0` | *"You found the target shape halfway through the hold—try setting your lips before you start your voice."* |
| **Mid-Hold Drift (`faded_late`)** | `nucleus_distance <= 1.1` and `offglide_distance > 1.5` (`trajectory_drift_bark > 0.8`) | *"Your sound started right in the target area, then drifted near the end—try holding that lip shape steady until you stop."* |
| **Damped / Nasalized Resonance (`high_b1_damping`)** | `learner.b1_nucleus_hz > target.b1_nucleus_hz * 1.8` (and $B_1 > 240\text{ Hz}$) | *"The resonance was a little muffled—try directing a clear, open sound through your mouth."* |
| **Breathy / Unsteady Voicing (`low_hnr_or_cpp`)** | `learner.hnr_mean_db < 9.0` or `intensity_drop_db < -8.0` | *"Your voice faded out quickly—take a comfortable breath and use a steady, clear tone."* |
| **Pitch Instability (`high_f0_iqr`)** | `learner.f0_iqr_st > 3.5` during a steady vowel task | *"Your pitch moved up and down during the vowel—try holding one comfortable, steady note."* |



---

# Part III: Microphone Hardware & Acoustic Capture Research

Selecting a microphone for the **Visual Speech Coach** requires balancing three strict project constraints:
1. **Clinical Acoustic Fidelity (`praat-parselmouth`):** Accurate LPC formant estimation ($F_1, F_2, F_3$, bandwidth $B_1$), pitch ($F_0$), Harmonics-to-Noise Ratio (HNR), Cepstral Peak Prominence (CPP), and spectral tilt ($H_1 - H_2$) following **ASHA Instrumental Voice Assessment Guidelines** (Patel et al., 2018; Švec & Granqvist, 2010, 2018).
2. **Multimodal Computer Vision Compatibility (`MediaPipe Face Landmarker`):** **Zero visual occlusion** of the lips (`0, 13, 14, 17`), oral commissures (`61, 291`), or chin (`152`) on the webcam feed ([`CameraTile.tsx`](file:///c:/Users/Omkar/calhacks/Articulate-cv/apps/web/src/CameraTile.tsx)).
3. **Environment Adaptability:** High Signal-to-Noise Ratio (SNR) in both a **noisy hackathon demo venue (Cal Hacks)** and a **quiet home/clinical practice room**.

---

## 1. Why Microphone Choice Makes or Breaks Our Pipeline

Our backend extracts vocal-tract resonances via Burg Linear Predictive Coding (`sound.to_formant_burg`) and periodicity via autocorrelation/cepstra (`to_pitch_ac`, `to_harmonicity_cc`, `PowerCepstrogram`). Microphone physics directly affect these algorithms in four ways:

| Acoustic Phenomenon | What Happens with the Wrong Mic | Impact on Our Backend (`features.py` / `scoring.py`) |
| :--- | :--- | :--- |
| **1. Ambient Crowd Noise & Room Reverb** | Far-field laptop mics or sensitive large-diaphragm condensers (e.g., Blue Yeti) act like acoustic sponges in a noisy room. | Background voices inject competing spectral peaks; LPC Burg poles jump erratically (`abrupt_track_change`), and noise floors crush `hnr_db` and `cpp_db`. |
| **2. Proximity Effect (Bass Boost)** | Directional (cardioid) capsules boost frequencies below $300\text{ Hz}$ by $+6\text{ to }+15\text{ dB}$ when placed $< 3\text{ cm}$ from the lips. | Artificially inflates $H_1$ ($f_0$) and pulls low $F_1$ estimates (for `/i/` at $300\text{ Hz}$ and `/u/` at $350\text{ Hz}$) downward toward $f_0$, skewing `f1Offset` and $H_1 - H_2$. |
| **3. Plosive Wind Blasts & Airflow** | Placing a capsule directly on-axis ($0^\circ$) in front of the mouth exposes the diaphragm to oral airflow. | Creates low-frequency clipping (`clipping` flag) and wide $B_1$ bandwidth distortion. |
| **4. Visual Lip/Jaw Occlusion** | Placing a large broadcast mic, pop shield, or bulky gaming headset boom in front of the mouth blocks the webcam. | MediaPipe loses inner/outer lip landmarks (`13, 14, 61, 291`) or hallucinates `mouthClose` / `jawOpen` blendshapes, breaking CV telemetry. |

---

## 2. The Multimodal Placement Rule: Zero-Occlusion Geometry

Because our system combines **audio formant tracking** with **webcam lip/jaw tracking**, physical microphone placement is as important as the capsule itself:

```
          [Webcam on Laptop/Monitor Top]
                        │
                        │  Unobstructed optical line of sight
                        ▼  to eyes (33, 263), lips (13, 14, 61, 291), & chin (152)
                 ┌─────────────┐
                 │  o       o  │
                 │      ▲      │
                 │   \_____/   │ ◀── 45° Off-Axis Earset Tip (stops behind mouth corner)
                 └──────┬──────┘
                        │
                        ↖ 30°–45° Below-Chin Desktop Dynamic Mic (5–8 cm away, angled up)
```

* **For Desktop Microphones:** Mount on a low desk stand or low-profile boom arm **5–8 cm (2–3 inches) below chin level (`landmark 152`), angled $30^\circ\text{–}45^\circ$ upward toward the mouth**. This keeps the mic body and cable completely below the jawline in the camera frame while avoiding direct plosive air blasts.
* **For Headworn / Earset Microphones:** Position the miniature boom along the cheek so the capsule sits **$2\text{–}3\text{ cm}$ outside the corner of the mouth (oral commissure) at a $45^\circ$ horizontal angle**, never crossing in front of the lips.

---

## 3. Top Microphone Recommendations by Budget & Use Case

### Category 0: Ultra-Budget Hackathon Picks (\$0 to \$39 — Same-Day / Backpack Ready)

For a hackathon demo on a tight budget, you do **not** need a \$250 studio mic. The goal is simply to get a clean, uncompressed $48\text{ kHz}$ capsule within $3\text{–}8\text{ cm}$ of the mouth (for high SNR over the hackathon crowd via the inverse-square law) while keeping it **below the chin or outside the mouth corner** so MediaPipe can see the lips.

| Budget Tier | Exact Model | Price | Why It Works for Our Pipeline | How to Use in the Live Demo |
| :--- | :--- | :--- | :--- | :--- |
| **\$0–\$19 Tier** *(Best Instant Pick — Target / Best Buy / Apple Store)* | **Wired Apple EarPods (USB-C or 3.5mm)** | \$17–\$19 *(often \$0 if a teammate has a pair)* | • Unlike Bluetooth AirPods (which drop to $8\text{–}16\text{ kHz}$ narrowband and gate vowels), **wired USB-C EarPods** have a built-in **$48\text{ kHz}$ / 24-bit ADC** with a raw, un-gated MEMS capsule and a clean $100\text{ Hz}\text{–}8\text{ kHz}$ formant response.<br>• Zero facial occlusion. | Put the right earbud in (or drape over the ear) and hold/pin the tiny inline mic pill **$4\text{ cm}$ below the chin or cheek corner** during the 60-second live demo. Gives $+18\text{ dB}$ SNR over a laptop mic! |
| **\$15–\$29 Tier** *(USB-C Omnidirectional Lavalier)* | **Saramonic LavMicro U3A / SR-ULM10U** (USB-C) | \$15–\$29 | • Native **$48\text{ kHz}$ / 16-bit** USB-C ADC, $50\text{ Hz}\text{–}20\text{ kHz}$ flat electret response, **zero proximity effect** (omni pressure transducer), and **zero onboard AI DSP**.<br>• Completely invisible to MediaPipe. | **Critical Placement Rule:** Do **not** clip low on the chest ($20\text{ cm}$ away) in a noisy room (chin shadows $F_2/F_3$ and omni capsule picks up crowd noise). Instead, **drape the thin cable over one ear** (earset style) or **hold/clip it $4\text{–}5\text{ cm}$ below the chin** for $+14\text{ dB}$ extra voice SNR! |
| **\$19–\$25 Tier** *(Passive Wired USB Boom Headset)* | **Sennheiser / EPOS PC 8 USB** (~\$24) or **Koss CS100 USB** (~\$20) or **Logitech H111** (~\$15) | \$15–\$25 | • Uses a passive analog **unidirectional noise-canceling electret capsule** (physical acoustic ports on both sides of the diaphragm cancel far-field crowd noise without any AI DSP chip that would eat sustained vowels).<br>• Fixed mouth-to-mic distance. | Pivot the thin boom arm slightly downward so the tip rests **at the corner of the jawline/chin**, leaving the lips and mouth corners completely unobstructed for the webcam. |
| **\$31–\$39 Tier** *(Cheapest True Dynamic Cardioid Mic)* | **Maono PD100U** (~\$35–\$39 USB-C Dynamic) *or* **Behringer XM8500** (\$19) + **USB-to-XLR Cable** (\$12) *or* **Fifine AM8** (~\$42) | \$31–\$42 | • True moving-coil **dynamic cardioid** capsule—physically insensitive to distant crowd chatter on the hackathon floor.<br>• Includes a low desktop tripod (Maono PD100U) and native USB-C plug-and-play. | Place on the desk **below chin level angled $45^\circ$ up** toward the speaker's mouth ($5\text{–}8\text{ cm}$ away). |

---

### Category A: Mid-Range Desktop Dynamic Cardioid Picks (\$70 to \$279)
**Form Factor:** **USB/XLR Dynamic Cardioid Microphone** (positioned below-chin, angled upward)

In a loud room full of people talking, a **dynamic cardioid capsule** is strongly preferred over a condenser. Dynamic capsules have higher moving mass and tight polar rejection at $180^\circ$, naturally starving background chatter ($> 15\text{ dB}$ off-axis rejection) when the speaker is $5\text{–}10\text{ cm}$ away.

| Microphone Model | Price | Connection | Why It Fits This Project | Setup / Caveats |
| :--- | :--- | :--- | :--- | :--- |
| **Samson Q2U** *(Best Value Pick)* | ~\$70 | USB + XLR | • Plug-and-play USB with zero onboard AI DSP that could mangle formants.<br>• Tight cardioid dynamic pickup rejects hackathon crowd noise.<br>• Compact handheld barrel easily tucks below chin level out of webcam view.<br>• Includes built-in $3.5\text{ mm}$ zero-latency headphone jack. | Keep $5\text{–}8\text{ cm}$ from the mouth at a $30^\circ\text{–}45^\circ$ upward angle so proximity effect stays mild and balanced. |
| **Audio-Technica ATR2100x-USB** | ~\$79 | USB-C + XLR | • Smooth, flat vocal response ($50\text{ Hz}\text{–}15\text{ kHz}$) well-suited for $F_1, F_2, F_3$ Burg LPC.<br>• Modern USB-C connector + 24-bit / up to $192\text{ kHz}$ ADC. | Same below-chin off-axis placement as the Q2U. |
| **Shure MV7+** *(Best Pro Desktop Pick)* | ~\$279 | USB-C + XLR | • Broadcast-grade dynamic capsule with tailored flat midrange ($50\text{ Hz}\text{–}16\text{ kHz}$) where $F_1\text{–}F_3$ live.<br>• Superior off-axis room noise rejection and low self-noise. | **Critical:** In Shure MOTIV Mix software, set to **Manual Mode** and turn **OFF** *Auto-Level*, *Real-Time Denoiser*, and *Digital Popper Stopper* so raw formant bandwidths and amplitudes remain unaltered. |

---

### Category B: Clinical Gold Standard (Fixed Mouth-to-Mic Distance)
**Form Factor:** **Head-Mounted / Single-Earset Microphone + Compact USB Preamp**

Per **ASHA Consensus Guidelines (Patel et al., 2018)** and **Švec & Granqvist (2010)**, a head-mounted microphone is the clinical gold standard for speech therapy biofeedback because **Mouth-to-Microphone Distance (MMD) remains constant** even when the learner turns or nods their head.

| Setup Tier | Recommended Hardware | Price | Why It Fits This Project |
| :--- | :--- | :--- | :--- |
| **Clinical Reference (Quiet / Treated Room)** | **Countryman E6 / H6 Omnidirectional Earset** (or **DPA 4066 / 4488**) + **Focusrite Scarlett Solo / Shure MVX2U** USB interface | ~\$350–\$600+ | • Wire-thin ($1\text{–}2\text{ mm}$) cheek boom is virtually invisible to MediaPipe Face Landmarker.<br>• Omnidirectional capsule has **zero proximity effect** and ruler-flat response ($\pm 2\text{ dB}$ from $20\text{ Hz}\text{–}20\text{ kHz}$), yielding laboratory-grade $F_1, F_2, F_3, B_1$, HNR, CPP, and $H_1-H_2$. |
| **Clinical Noisy-Room / Hackathon Earset** | **Shure WH20XLR** (Dynamic Cardioid Headset) or **Shure PGA31** + **Shure MVX2U** (XLR-to-USB-C adapter) | ~\$200–\$230 total | • Dynamic cardioid headworn capsule combines fixed mouth distance with aggressive background noise rejection.<br>• Bend the gooseneck so the capsule sits just outside the cheek corner without crossing the lips. |

---

### Category C: Best for Quiet-Room Calibration & Zero Proximity Effect
**Form Factor:** **Calibrated USB Omnidirectional Measurement Condenser**

If testing in a quiet room ($< 38\text{ dBC}$ ambient noise) where a desktop mic is preferred over a headset:
* **miniDSP UMIK-1 (~$79)** or **Dayton Audio UMM-6 (~$65)**:
  * Unlike podcast/gaming condensers that boost bass and treble, acoustic measurement microphones use a tiny $6\text{ mm}$ omnidirectional electret capsule with an individual factory calibration file ($\pm 1\text{ dB}$ from $20\text{ Hz}\text{–}20\text{ kHz}$).
  * Because omnidirectional capsules are pressure transducers (not pressure-gradient transducers), they exhibit **zero proximity effect**—meaning $F_1$ and $H_1 - H_2$ spectral tilt remain true even if the speaker's distance shifts slightly.
  * *Limitation:* Do **not** use an omnidirectional measurement mic on a noisy hackathon floor, as it picks up sound equally from $360^\circ$.

---

## 4. Microphones & Features to Explicitly Avoid

1. **Multi-Capsule USB Condensers in Noisy Rooms (e.g., Blue Yeti, HyperX QuadCast, Razer Seiren):**
   * High sensitivity and wide cardioid lobes capture room modes, laptop fan hum, and neighboring voices, causing false `unvoiced` or `implausible_formants` flags in [`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py#L44-L47).
2. **Bluetooth Headsets / AirPods / Earbuds:**
   * Bluetooth Hands-Free Profile (HFP / SCO) drops the audio sampling rate to **$8\text{ kHz}$ or $16\text{ kHz}$ narrowband/wideband** with aggressive lossy codec compression and voice-activity gating. At $8\text{ kHz}$ sample rate (Nyquist $= 4\text{ kHz}$), Praat's Burg LPC ($5\text{ formants up to } 5500\text{ Hz}$) completely fails!
3. **Chest-Clipped Lavalier Mics (e.g., Rode Wireless GO / DJI Mic clipped to shirt collar):**
   * The chin and chest shadow high frequencies ($> 2\text{ kHz}$, attenuating $F_2$ for `/i/` and $F_3$), and turning the head changes the mouth-to-collar distance and spectral tilt.
4. **Call-Center / Gaming Headsets with Hardware AI Noise Cancellation (e.g., Krisp, NVIDIA Broadcast, Poly Acoustic Fence):**
   * Neural noise-suppression chips are trained on conversational speech, not sustained isolated vowels (`/i/`, `/u/`, `/ɑ/`). When a learner holds a steady vowel for $1.5\text{ seconds}$, AI denoisers frequently classify the steady harmonic tone as stationary fan/hum noise and **attenuate or notch out the vowel formants after $300\text{ ms}$**.

---

## 5. Browser Web Audio API & OS Configuration Checklist

Even with the right physical microphone, browser and OS settings must be configured for raw acoustic measurement:

1. **Disable All WebRTC DSP Filters in `getUserMedia`:**
   * In [`useMicrophone.ts`](file:///c:/Users/Omkar/calhacks/Articulate-main/web/src/audio/useMicrophone.ts#L99-L106) (`Articulate-main`), all three WebRTC filters are properly disabled (`echoCancellation: false, noiseSuppression: false, autoGainControl: false`).
   * **Note on [`audio.ts`](file:///c:/Users/Omkar/calhacks/Articulate/apps/web/src/audio.ts#L148-L153) (`Articulate`):** Line 150 currently sets `echoCancellation: true`. Because our controller already stops TTS playback before recording the learner, `echoCancellation` should be set to `false` so Chrome's WebRTC acoustic echo canceller (AEC3) and nonlinear residual suppressor do not color the vowel spectrum.
2. **Disable Windows / macOS OS-Level "Audio Enhancements":**
   * On Windows 11 (*Settings $\rightarrow$ System $\rightarrow$ Sound $\rightarrow$ Input Device Properties*), set **Audio Enhancements** to **Off** (disabling Intel Smart Sound / Realtek AI Noise Cancellation).
   * On macOS, set the Mic Mode in Control Center to **Standard** (never *Voice Isolation*).
3. **Sample Rate & Gain Staging:**
   * Lock USB microphone input format to **$48\text{ kHz}$, 16-bit or 24-bit PCM** (matches our `AudioWorklet` pipeline).
   * Set hardware/OS input gain so a comfortable sustained vowel peaks around **$-12\text{ dBFS to }-6\text{ dBFS}$** ($\text{RMS} \approx 0.08\text{–}0.20$), staying well above the `silence` floor ($\text{RMS} = 0.008$) and well below the `clipping` threshold ($0.99$).

---

## 6. Deep Dive: "Judge Holds Mic Close to Mouth" in an Extremely Noisy Hackathon Room

When a judge or presenter holds a microphone **$2\text{–}5\text{ cm}$ from their mouth** in an extremely loud venue (80–85 dB ambient crowd noise), two physical phenomena occur:
1. **The Lombard Effect:** Humans subconsciously speak **$+10\text{ to }+15\text{ dB}$ louder** in noisy rooms. At $3\text{ cm}$ distance, vocal Sound Pressure Level (SPL) reaches **$105\text{–}115\text{ dB SPL}$**.
2. **Oral Airflow / Plosive Turbulence:** At $<4\text{ cm}$, even steady vowels carry warm air currents that buffet unshielded capsules.

### How the Saramonic USB-C Lavalier Holds Up Close-to-Mouth vs. a Handheld Dynamic Cardioid

| Criterion (Close-Mouth, Extremely Noisy Room) | **Saramonic USB-C Lav (Omnidirectional Condenser)** | **Handheld USB Dynamic Cardioid (Samson Q2U / ATR2100x / Maono PD100U)** |
| :--- | :--- | :--- |
| **Background Crowd Noise Rejection** | **Moderate (Distance Only):** Because it is **omnidirectional** ($360^\circ$ pickup, $0\text{ dB}$ Directivity Index), it relies *entirely* on being close to the mouth ($3\text{–}5\text{ cm}$) to overpower the crowd. It does not reject noise from behind. | **Maximum (Distance + Polar Pattern):** Combines close distance with a **tight cardioid pattern** that physically rejects sound from the sides/rear by an **additional $12\text{–}18\text{ dB}$**. |
| **Overload / Clipping Risk at $2\text{–}4\text{ cm}$** | **High if Uncalibrated:** Lavaliers are factory-gained for chest distance ($20\text{ cm}$, $-40\text{ dB}$ sensitivity). Held $2\text{ cm}$ from a loud voice, the built-in USB-C ADC will **hard-clip** (triggering our `clipping` rejection flag in [`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py#L27-L28)) unless OS input gain is turned down to **20–35%**. | **Virtually Zero:** Moving-coil dynamic capsules have low sensitivity ($-54\text{ dB}$) and handle **$>130\text{ dB SPL}$** right on the grille without clipping. |
| **Breath / Wind Buffeting** | **Sensitive:** Tiny $6\text{ mm}$ foam cap saturates if held directly in front of the lips ($0^\circ$). Must be held slightly below the chin or to the side ($45^\circ$). | **Built for Close-Talk:** Heavy steel mesh grille + internal foam stage windscreen absorbs close breath blasts. |
| **Judge Ergonomics ("Pass the Mic")** | Awkward to hold a floppy wire; fingers rubbing the cable create low-frequency handling thumps. *(Fix: tape the clip to a rigid pen/chopstick as a mini handheld wand!)* | Natural "ice-cream cone" handheld barrel; zero cable-rub noise; easy to hold below the chin out of webcam view. |

### Verdict & Action Plan
* **If you can spend \$35–\$70 for the safest possible noisy-room demo:** Get a **USB Dynamic Cardioid Handheld Mic** (**Samson Q2U** ~\$70, **ATR2100x-USB** ~\$79, or **Maono PD100U** ~\$39). Have the judge hold it like an ice-cream cone **$3\text{–}5\text{ cm}$ below their chin angled $45^\circ$ up**. It will reject the hackathon crowd far better than any lavalier and **will not clip** when the judge speaks loudly.
* **If you use the Saramonic USB-C Lavalier held close to the mouth:** It **will work**, provided you do these three things before judges arrive:
  1. **Lower OS Input Volume to ~25–35%:** Test holding it $4\text{ cm}$ from your mouth while speaking loudly (hackathon volume) and lower the Windows/macOS microphone input slider until peaks stay below $0.70$ (so the judge never triggers the `0.99` `clipping` failure in [`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py#L27-L28)).
  2. **Tape/Clip It to a Rigid Wand (e.g., a Pen or Chopstick):** Clip the Saramonic onto the tip of a pen/marker so the judge holds the pen rather than pinching the wire or rubbing the capsule.
  3. **Hold $4\text{ cm}$ Below the Chin or Cheek Corner (Never Dead-Center in Front of the Lips):** Keeps breath puffs off the capsule and keeps the lips 100% visible for MediaPipe.

---

## 7. Summary Decision Matrix

| Scenario | #1 Recommended Mic | Backup / Budget Pick | Placement |
| :--- | :--- | :--- | :--- |
| **Cal Hacks Demo & General Desktop Use** | **Shure MV7+** (USB-C Dynamic, DSP Off) | **Samson Q2U** (~\$70) or **ATR2100x-USB** (~\$79) | Handheld or low stand, **$3\text{–}6\text{ cm}$ below chin**, angled $45^\circ$ up (zero webcam lip occlusion) |
| **Ultra-Budget Hackathon (<\$40)** | **Maono PD100U** (~\$39 USB-C Dynamic) | **Saramonic LavMicro U3A** (~\$25) or **Wired Apple EarPods** (\$19) | Held **$4\text{ cm}$ below chin** with OS gain lowered to ~30% to prevent close-talk clipping |
| **Clinical / Research Gold Standard** | **Countryman E6 / DPA 4066 Earset** + Focusrite Scarlett Solo | **Shure WH20XLR** + Shure MVX2U USB adapter | Cheek-hugging wire, **$2\text{–}3\text{ cm}$ off mouth corner** at $45^\circ$ |
| **Quiet Room Calibration / Zero Proximity Effect** | **miniDSP UMIK-1** (Calibrated USB Omni) | **Dayton Audio UMM-6** | Desk stand, **$15\text{–}20\text{ cm}$ off-axis** at $30^\circ$ |


---

# Part III: Microphone Hardware & Acoustic Capture Research

Selecting a microphone for the **Visual Speech Coach** requires balancing three strict project constraints:
1. **Clinical Acoustic Fidelity (`praat-parselmouth`):** Accurate LPC formant estimation ($F_1, F_2, F_3$, bandwidth $B_1$), pitch ($F_0$), Harmonics-to-Noise Ratio (HNR), Cepstral Peak Prominence (CPP), and spectral tilt ($H_1 - H_2$) following **ASHA Instrumental Voice Assessment Guidelines** (Patel et al., 2018; Švec & Granqvist, 2010, 2018).
2. **Multimodal Computer Vision Compatibility (`MediaPipe Face Landmarker`):** **Zero visual occlusion** of the lips (`0, 13, 14, 17`), oral commissures (`61, 291`), or chin (`152`) on the webcam feed ([`CameraTile.tsx`](file:///c:/Users/Omkar/calhacks/Articulate-cv/apps/web/src/CameraTile.tsx)).
3. **Environment Adaptability:** High Signal-to-Noise Ratio (SNR) in both a **noisy hackathon demo venue (Cal Hacks)** and a **quiet home/clinical practice room**.

---

## 1. Why Microphone Choice Makes or Breaks Our Pipeline

Our backend extracts vocal-tract resonances via Burg Linear Predictive Coding (`sound.to_formant_burg`) and periodicity via autocorrelation/cepstra (`to_pitch_ac`, `to_harmonicity_cc`, `PowerCepstrogram`). Microphone physics directly affect these algorithms in four ways:

| Acoustic Phenomenon | What Happens with the Wrong Mic | Impact on Our Backend (`features.py` / `scoring.py`) |
| :--- | :--- | :--- |
| **1. Ambient Crowd Noise & Room Reverb** | Far-field laptop mics or sensitive large-diaphragm condensers (e.g., Blue Yeti) act like acoustic sponges in a noisy room. | Background voices inject competing spectral peaks; LPC Burg poles jump erratically (`abrupt_track_change`), and noise floors crush `hnr_db` and `cpp_db`. |
| **2. Proximity Effect (Bass Boost)** | Directional (cardioid) capsules boost frequencies below $300\text{ Hz}$ by $+6\text{ to }+15\text{ dB}$ when placed $< 3\text{ cm}$ from the lips. | Artificially inflates $H_1$ ($f_0$) and pulls low $F_1$ estimates (for `/i/` at $300\text{ Hz}$ and `/u/` at $350\text{ Hz}$) downward toward $f_0$, skewing `f1Offset` and $H_1 - H_2$. |
| **3. Plosive Wind Blasts & Airflow** | Placing a capsule directly on-axis ($0^\circ$) in front of the mouth exposes the diaphragm to oral airflow. | Creates low-frequency clipping (`clipping` flag) and wide $B_1$ bandwidth distortion. |
| **4. Visual Lip/Jaw Occlusion** | Placing a large broadcast mic, pop shield, or bulky gaming headset boom in front of the mouth blocks the webcam. | MediaPipe loses inner/outer lip landmarks (`13, 14, 61, 291`) or hallucinates `mouthClose` / `jawOpen` blendshapes, breaking CV telemetry. |

---

## 2. The Multimodal Placement Rule: Zero-Occlusion Geometry

Because our system combines **audio formant tracking** with **webcam lip/jaw tracking**, physical microphone placement is as important as the capsule itself:

```
          [Webcam on Laptop/Monitor Top]
                        │
                        │  Unobstructed optical line of sight
                        ▼  to eyes (33, 263), lips (13, 14, 61, 291), & chin (152)
                 ┌─────────────┐
                 │  o       o  │
                 │      ▲      │
                 │   \_____/   │ ◀── 45° Off-Axis Earset Tip (stops behind mouth corner)
                 └──────┬──────┘
                        │
                        ↖ 30°–45° Below-Chin Desktop Dynamic Mic (5–8 cm away, angled up)
```

* **For Desktop Microphones:** Mount on a low desk stand or low-profile boom arm **5–8 cm (2–3 inches) below chin level (`landmark 152`), angled $30^\circ\text{–}45^\circ$ upward toward the mouth**. This keeps the mic body and cable completely below the jawline in the camera frame while avoiding direct plosive air blasts.
* **For Headworn / Earset Microphones:** Position the miniature boom along the cheek so the capsule sits **$2\text{–}3\text{ cm}$ outside the corner of the mouth (oral commissure) at a $45^\circ$ horizontal angle**, never crossing in front of the lips.

---

## 3. Top Microphone Recommendations by Budget & Use Case

### Category 0: Ultra-Budget Hackathon Picks (\$0 to \$39 — Same-Day / Backpack Ready)

For a hackathon demo on a tight budget, you do **not** need a \$250 studio mic. The goal is simply to get a clean, uncompressed $48\text{ kHz}$ capsule within $3\text{–}8\text{ cm}$ of the mouth (for high SNR over the hackathon crowd via the inverse-square law) while keeping it **below the chin or outside the mouth corner** so MediaPipe can see the lips.

| Budget Tier | Exact Model | Price | Why It Works for Our Pipeline | How to Use in the Live Demo |
| :--- | :--- | :--- | :--- | :--- |
| **\$0–\$19 Tier** *(Best Instant Pick — Target / Best Buy / Apple Store)* | **Wired Apple EarPods (USB-C or 3.5mm)** | \$17–\$19 *(often \$0 if a teammate has a pair)* | • Unlike Bluetooth AirPods (which drop to $8\text{–}16\text{ kHz}$ narrowband and gate vowels), **wired USB-C EarPods** have a built-in **$48\text{ kHz}$ / 24-bit ADC** with a raw, un-gated MEMS capsule and a clean $100\text{ Hz}\text{–}8\text{ kHz}$ formant response.<br>• Zero facial occlusion. | Put the right earbud in (or drape over the ear) and hold/pin the tiny inline mic pill **$4\text{ cm}$ below the chin or cheek corner** during the 60-second live demo. Gives $+18\text{ dB}$ SNR over a laptop mic! |
| **\$15–\$29 Tier** *(USB-C Omnidirectional Lavalier)* | **Saramonic LavMicro U3A / SR-ULM10U** (USB-C) | \$15–\$29 | • Native **$48\text{ kHz}$ / 16-bit** USB-C ADC, $50\text{ Hz}\text{–}20\text{ kHz}$ flat electret response, **zero proximity effect** (omni pressure transducer), and **zero onboard AI DSP**.<br>• Completely invisible to MediaPipe. | **Critical Placement Rule:** Do **not** clip low on the chest ($20\text{ cm}$ away) in a noisy room (chin shadows $F_2/F_3$ and omni capsule picks up crowd noise). Instead, **drape the thin cable over one ear** (earset style) or **hold/clip it $4\text{–}5\text{ cm}$ below the chin** for $+14\text{ dB}$ extra voice SNR! |
| **\$19–\$25 Tier** *(Passive Wired USB Boom Headset)* | **Sennheiser / EPOS PC 8 USB** (~\$24) or **Koss CS100 USB** (~\$20) or **Logitech H111** (~\$15) | \$15–\$25 | • Uses a passive analog **unidirectional noise-canceling electret capsule** (physical acoustic ports on both sides of the diaphragm cancel far-field crowd noise without any AI DSP chip that would eat sustained vowels).<br>• Fixed mouth-to-mic distance. | Pivot the thin boom arm slightly downward so the tip rests **at the corner of the jawline/chin**, leaving the lips and mouth corners completely unobstructed for the webcam. |
| **\$31–\$39 Tier** *(Cheapest True Dynamic Cardioid Mic)* | **Maono PD100U** (~\$35–\$39 USB-C Dynamic) *or* **Behringer XM8500** (\$19) + **USB-to-XLR Cable** (\$12) *or* **Fifine AM8** (~\$42) | \$31–\$42 | • True moving-coil **dynamic cardioid** capsule—physically insensitive to distant crowd chatter on the hackathon floor.<br>• Includes a low desktop tripod (Maono PD100U) and native USB-C plug-and-play. | Place on the desk **below chin level angled $45^\circ$ up** toward the speaker's mouth ($5\text{–}8\text{ cm}$ away). |

---

### Category A: Mid-Range Desktop Dynamic Cardioid Picks (\$70 to \$279)
**Form Factor:** **USB/XLR Dynamic Cardioid Microphone** (positioned below-chin, angled upward)

In a loud room full of people talking, a **dynamic cardioid capsule** is strongly preferred over a condenser. Dynamic capsules have higher moving mass and tight polar rejection at $180^\circ$, naturally starving background chatter ($> 15\text{ dB}$ off-axis rejection) when the speaker is $5\text{–}10\text{ cm}$ away.

| Microphone Model | Price | Connection | Why It Fits This Project | Setup / Caveats |
| :--- | :--- | :--- | :--- | :--- |
| **Samson Q2U** *(Best Value Pick)* | ~\$70 | USB + XLR | • Plug-and-play USB with zero onboard AI DSP that could mangle formants.<br>• Tight cardioid dynamic pickup rejects hackathon crowd noise.<br>• Compact handheld barrel easily tucks below chin level out of webcam view.<br>• Includes built-in $3.5\text{ mm}$ zero-latency headphone jack. | Keep $5\text{–}8\text{ cm}$ from the mouth at a $30^\circ\text{–}45^\circ$ upward angle so proximity effect stays mild and balanced. |
| **Audio-Technica ATR2100x-USB** | ~\$79 | USB-C + XLR | • Smooth, flat vocal response ($50\text{ Hz}\text{–}15\text{ kHz}$) well-suited for $F_1, F_2, F_3$ Burg LPC.<br>• Modern USB-C connector + 24-bit / up to $192\text{ kHz}$ ADC. | Same below-chin off-axis placement as the Q2U. |
| **Shure MV7+** *(Best Pro Desktop Pick)* | ~\$279 | USB-C + XLR | • Broadcast-grade dynamic capsule with tailored flat midrange ($50\text{ Hz}\text{–}16\text{ kHz}$) where $F_1\text{–}F_3$ live.<br>• Superior off-axis room noise rejection and low self-noise. | **Critical:** In Shure MOTIV Mix software, set to **Manual Mode** and turn **OFF** *Auto-Level*, *Real-Time Denoiser*, and *Digital Popper Stopper* so raw formant bandwidths and amplitudes remain unaltered. |

---

### Category B: Clinical Gold Standard (Fixed Mouth-to-Mic Distance)
**Form Factor:** **Head-Mounted / Single-Earset Microphone + Compact USB Preamp**

Per **ASHA Consensus Guidelines (Patel et al., 2018)** and **Švec & Granqvist (2010)**, a head-mounted microphone is the clinical gold standard for speech therapy biofeedback because **Mouth-to-Microphone Distance (MMD) remains constant** even when the learner turns or nods their head.

| Setup Tier | Recommended Hardware | Price | Why It Fits This Project |
| :--- | :--- | :--- | :--- |
| **Clinical Reference (Quiet / Treated Room)** | **Countryman E6 / H6 Omnidirectional Earset** (or **DPA 4066 / 4488**) + **Focusrite Scarlett Solo / Shure MVX2U** USB interface | ~\$350–\$600+ | • Wire-thin ($1\text{–}2\text{ mm}$) cheek boom is virtually invisible to MediaPipe Face Landmarker.<br>• Omnidirectional capsule has **zero proximity effect** and ruler-flat response ($\pm 2\text{ dB}$ from $20\text{ Hz}\text{–}20\text{ kHz}$), yielding laboratory-grade $F_1, F_2, F_3, B_1$, HNR, CPP, and $H_1-H_2$. |
| **Clinical Noisy-Room / Hackathon Earset** | **Shure WH20XLR** (Dynamic Cardioid Headset) or **Shure PGA31** + **Shure MVX2U** (XLR-to-USB-C adapter) | ~\$200–\$230 total | • Dynamic cardioid headworn capsule combines fixed mouth distance with aggressive background noise rejection.<br>• Bend the gooseneck so the capsule sits just outside the cheek corner without crossing the lips. |

---

### Category C: Best for Quiet-Room Calibration & Zero Proximity Effect
**Form Factor:** **Calibrated USB Omnidirectional Measurement Condenser**

If testing in a quiet room ($< 38\text{ dBC}$ ambient noise) where a desktop mic is preferred over a headset:
* **miniDSP UMIK-1 (~$79)** or **Dayton Audio UMM-6 (~$65)**:
  * Unlike podcast/gaming condensers that boost bass and treble, acoustic measurement microphones use a tiny $6\text{ mm}$ omnidirectional electret capsule with an individual factory calibration file ($\pm 1\text{ dB}$ from $20\text{ Hz}\text{–}20\text{ kHz}$).
  * Because omnidirectional capsules are pressure transducers (not pressure-gradient transducers), they exhibit **zero proximity effect**—meaning $F_1$ and $H_1 - H_2$ spectral tilt remain true even if the speaker's distance shifts slightly.
  * *Limitation:* Do **not** use an omnidirectional measurement mic on a noisy hackathon floor, as it picks up sound equally from $360^\circ$.

---

## 4. Microphones & Features to Explicitly Avoid

1. **Multi-Capsule USB Condensers in Noisy Rooms (e.g., Blue Yeti, HyperX QuadCast, Razer Seiren):**
   * High sensitivity and wide cardioid lobes capture room modes, laptop fan hum, and neighboring voices, causing false `unvoiced` or `implausible_formants` flags in [`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py#L44-L47).
2. **Bluetooth Headsets / AirPods / Earbuds:**
   * Bluetooth Hands-Free Profile (HFP / SCO) drops the audio sampling rate to **$8\text{ kHz}$ or $16\text{ kHz}$ narrowband/wideband** with aggressive lossy codec compression and voice-activity gating. At $8\text{ kHz}$ sample rate (Nyquist $= 4\text{ kHz}$), Praat's Burg LPC ($5\text{ formants up to } 5500\text{ Hz}$) completely fails!
3. **Chest-Clipped Lavalier Mics (e.g., Rode Wireless GO / DJI Mic clipped to shirt collar):**
   * The chin and chest shadow high frequencies ($> 2\text{ kHz}$, attenuating $F_2$ for `/i/` and $F_3$), and turning the head changes the mouth-to-collar distance and spectral tilt.
4. **Call-Center / Gaming Headsets with Hardware AI Noise Cancellation (e.g., Krisp, NVIDIA Broadcast, Poly Acoustic Fence):**
   * Neural noise-suppression chips are trained on conversational speech, not sustained isolated vowels (`/i/`, `/u/`, `/ɑ/`). When a learner holds a steady vowel for $1.5\text{ seconds}$, AI denoisers frequently classify the steady harmonic tone as stationary fan/hum noise and **attenuate or notch out the vowel formants after $300\text{ ms}$**.

---

## 5. Browser Web Audio API & OS Configuration Checklist

Even with the right physical microphone, browser and OS settings must be configured for raw acoustic measurement:

1. **Disable All WebRTC DSP Filters in `getUserMedia`:**
   * In [`useMicrophone.ts`](file:///c:/Users/Omkar/calhacks/Articulate-main/web/src/audio/useMicrophone.ts#L99-L106) (`Articulate-main`), all three WebRTC filters are properly disabled (`echoCancellation: false, noiseSuppression: false, autoGainControl: false`).
   * **Note on [`audio.ts`](file:///c:/Users/Omkar/calhacks/Articulate/apps/web/src/audio.ts#L148-L153) (`Articulate`):** Line 150 currently sets `echoCancellation: true`. Because our controller already stops TTS playback before recording the learner, `echoCancellation` should be set to `false` so Chrome's WebRTC acoustic echo canceller (AEC3) and nonlinear residual suppressor do not color the vowel spectrum.
2. **Disable Windows / macOS OS-Level "Audio Enhancements":**
   * On Windows 11 (*Settings $\rightarrow$ System $\rightarrow$ Sound $\rightarrow$ Input Device Properties*), set **Audio Enhancements** to **Off** (disabling Intel Smart Sound / Realtek AI Noise Cancellation).
   * On macOS, set the Mic Mode in Control Center to **Standard** (never *Voice Isolation*).
3. **Sample Rate & Gain Staging:**
   * Lock USB microphone input format to **$48\text{ kHz}$, 16-bit or 24-bit PCM** (matches our `AudioWorklet` pipeline).
   * Set hardware/OS input gain so a comfortable sustained vowel peaks around **$-12\text{ dBFS to }-6\text{ dBFS}$** ($\text{RMS} \approx 0.08\text{–}0.20$), staying well above the `silence` floor ($\text{RMS} = 0.008$) and well below the `clipping` threshold ($0.99$).

---

## 6. Deep Dive: "Judge Holds Mic Close to Mouth" in an Extremely Noisy Hackathon Room

When a judge or presenter holds a microphone **$2\text{–}5\text{ cm}$ from their mouth** in an extremely loud venue (80–85 dB ambient crowd noise), two physical phenomena occur:
1. **The Lombard Effect:** Humans subconsciously speak **$+10\text{ to }+15\text{ dB}$ louder** in noisy rooms. At $3\text{ cm}$ distance, vocal Sound Pressure Level (SPL) reaches **$105\text{–}115\text{ dB SPL}$**.
2. **Oral Airflow / Plosive Turbulence:** At $<4\text{ cm}$, even steady vowels carry warm air currents that buffet unshielded capsules.

### How the Saramonic USB-C Lavalier Holds Up Close-to-Mouth vs. a Handheld Dynamic Cardioid

| Criterion (Close-Mouth, Extremely Noisy Room) | **Saramonic USB-C Lav (Omnidirectional Condenser)** | **Handheld USB Dynamic Cardioid (Samson Q2U / ATR2100x / Maono PD100U)** |
| :--- | :--- | :--- |
| **Background Crowd Noise Rejection** | **Moderate (Distance Only):** Because it is **omnidirectional** ($360^\circ$ pickup, $0\text{ dB}$ Directivity Index), it relies *entirely* on being close to the mouth ($3\text{–}5\text{ cm}$) to overpower the crowd. It does not reject noise from behind. | **Maximum (Distance + Polar Pattern):** Combines close distance with a **tight cardioid pattern** that physically rejects sound from the sides/rear by an **additional $12\text{–}18\text{ dB}$**. |
| **Overload / Clipping Risk at $2\text{–}4\text{ cm}$** | **High if Uncalibrated:** Lavaliers are factory-gained for chest distance ($20\text{ cm}$, $-40\text{ dB}$ sensitivity). Held $2\text{ cm}$ from a loud voice, the built-in USB-C ADC will **hard-clip** (triggering our `clipping` rejection flag in [`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py#L27-L28)) unless OS input gain is turned down to **20–35%**. | **Virtually Zero:** Moving-coil dynamic capsules have low sensitivity ($-54\text{ dB}$) and handle **$>130\text{ dB SPL}$** right on the grille without clipping. |
| **Breath / Wind Buffeting** | **Sensitive:** Tiny $6\text{ mm}$ foam cap saturates if held directly in front of the lips ($0^\circ$). Must be held slightly below the chin or to the side ($45^\circ$). | **Built for Close-Talk:** Heavy steel mesh grille + internal foam stage windscreen absorbs close breath blasts. |
| **Judge Ergonomics ("Pass the Mic")** | Awkward to hold a floppy wire; fingers rubbing the cable create low-frequency handling thumps. *(Fix: tape the clip to a rigid pen/chopstick as a mini handheld wand!)* | Natural "ice-cream cone" handheld barrel; zero cable-rub noise; easy to hold below the chin out of webcam view. |

### Verdict & Action Plan
* **If you can spend \$35–\$70 for the safest possible noisy-room demo:** Get a **USB Dynamic Cardioid Handheld Mic** (**Samson Q2U** ~\$70, **ATR2100x-USB** ~\$79, or **Maono PD100U** ~\$39). Have the judge hold it like an ice-cream cone **$3\text{–}5\text{ cm}$ below their chin angled $45^\circ$ up**. It will reject the hackathon crowd far better than any lavalier and **will not clip** when the judge speaks loudly.
* **If you use the Saramonic USB-C Lavalier held close to the mouth:** It **will work**, provided you do these three things before judges arrive:
  1. **Lower OS Input Volume to ~25–35%:** Test holding it $4\text{ cm}$ from your mouth while speaking loudly (hackathon volume) and lower the Windows/macOS microphone input slider until peaks stay below $0.70$ (so the judge never triggers the `0.99` `clipping` failure in [`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py#L27-L28)).
  2. **Tape/Clip It to a Rigid Wand (e.g., a Pen or Chopstick):** Clip the Saramonic onto the tip of a pen/marker so the judge holds the pen rather than pinching the wire or rubbing the capsule.
  3. **Hold $4\text{ cm}$ Below the Chin or Cheek Corner (Never Dead-Center in Front of the Lips):** Keeps breath puffs off the capsule and keeps the lips 100% visible for MediaPipe.

---

## 7. Summary Decision Matrix

| Scenario | #1 Recommended Mic | Backup / Budget Pick | Placement |
| :--- | :--- | :--- | :--- |
| **Cal Hacks Demo & General Desktop Use** | **Shure MV7+** (USB-C Dynamic, DSP Off) | **Samson Q2U** (~\$70) or **ATR2100x-USB** (~\$79) | Handheld or low stand, **$3\text{–}6\text{ cm}$ below chin**, angled $45^\circ$ up (zero webcam lip occlusion) |
| **Ultra-Budget Hackathon (<\$40)** | **Maono PD100U** (~\$39 USB-C Dynamic) | **Saramonic LavMicro U3A** (~\$25) or **Wired Apple EarPods** (\$19) | Held **$4\text{ cm}$ below chin** with OS gain lowered to ~30% to prevent close-talk clipping |
| **Clinical / Research Gold Standard** | **Countryman E6 / DPA 4066 Earset** + Focusrite Scarlett Solo | **Shure WH20XLR** + Shure MVX2U USB adapter | Cheek-hugging wire, **$2\text{–}3\text{ cm}$ off mouth corner** at $45^\circ$ |
| **Quiet Room Calibration / Zero Proximity Effect** | **miniDSP UMIK-1** (Calibrated USB Omni) | **Dayton Audio UMM-6** | Desk stand, **$15\text{–}20\text{ cm}$ off-axis** at $30^\circ$ |

