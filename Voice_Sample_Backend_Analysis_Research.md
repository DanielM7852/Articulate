# Backend Voice Sample Analysis & Target Comparison Research: Visual Speech Coach

This report investigates what backend acoustic, prosodic, voice-quality, and neural articulatory analyses our Python service can run on a **learner's voice sample** to compare it against a **target reference voice sample**, and how those measurements translate into grounded evidence for the Claude coaching agent.

It builds directly on the existing audio pipelines in [Articulate-main](file:///c:/Users/Omkar/calhacks/Articulate-main) ([`scoring.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/scoring.py), [`extract.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/extract.py), [`compare.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/compare.py)) and [Articulate](file:///c:/Users/Omkar/calhacks/Articulate) ([`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py)), while adhering to the architectural and clinical boundaries in [Visual_Speech_Coach_Roadmap.md](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md).

---

## 1. Current Baseline vs. What Is Missing

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
   Praat's Burg LPC requires a speaker-appropriate `maximum_formant` ceiling (typically $5000\text{ Hz}$ for adult males, $5500\text{ Hz}$ for adult females, $6000\text{–}6500\text{ Hz}$ for children). The backend can automatically select or refine `maximum_formant` per sample by conditioning on the speaker's median fundamental frequency ($F_0$) or minimizing LPC formant bandwidth variance across $\{5000, 5500, 6000\}\text{ Hz}$.

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
   Fit a robust Theil–Sen or linear slope across the nucleus and compute the **Trajectory Vector Length (TVL)** in Bark space from $20\%$ to $80\%$ duration:

   $$\text{TVL}_{\text{bark}} = \sqrt{\left(\Delta(Z_3 - Z_1)_{20\to 80}\right)^2 + \left(\Delta(Z_3 - Z_2)_{20\to 80}\right)^2}$$

   * If $\text{TVL}_{\text{learn}} \gg \text{TVL}_{\text{ref}}$, the learner's articulators are drifting during the hold.
   * Comparing `onset_distance` vs. `nucleus_distance` vs. `offglide_distance` tells the agent whether the learner **converged toward** the target (`converging`), **drifted away** (`fading_hold`), or stayed **steady** (`stable_hold`).

3. **Multivariate Formant-Trajectory DTW (`formant_dtw_rmse_bark`):**
   Using the same band-constrained Sakoe-Chiba DTW already in [`compare.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/compare.py#L112-L132), align the learner's 2D normalized formant curve $\mathbf{z}_{\text{learn}}(t) = [Z_3-Z_1, Z_3-Z_2]$ against the target sample's curve $\mathbf{z}_{\text{ref}}(t)$. This is especially valuable when transitioning from steady monophthongs to words or diphthongs (`/aɪ/`, `/oʊ/`).

---

### Tier 3: Phonation, Voice Quality, Vocal Effort & Nasality (`parselmouth` Deep Extraction)

#### Why Voice Quality Matters for DHH Learners
As established in clinical DHH literature, reduced auditory feedback often causes secondary phonation and resonance habits when learners concentrate hard on hitting a vowel target:
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

Even during single-vowel or single-word practice, comparing the **suprasegmental envelope** of the learner sample against the target sample provides vital coaching context:

1. **Pitch Stability & Intonation Match (`f0_ IQR_st`, `aligned_pitch_rmse_st`):**
   * Unify the pitch contour extractor in [`extract.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/extract.py) with the vowel analyzer so every vowel attempt also reports **semitone steadiness** ($\text{IQR of } 12 \log_2(F_0 / \text{median}(F_0))$).
   * If a learner's pitch wavers wildly ($\text{IQR} > 3.5\text{ st}$) during a sustained vowel task, LPC formant estimates can jump as harmonics cross formant peaks; the coach can gently cue *"Hold a steady, comfortable note."*
2. **Intensity Envelope & Attack/Decay Shape (`intensity_std_db`, `intensity_drop_db`):**
   * Extracted via `sound.to_intensity(minimum_pitch=75)`.
   * Measures whether the learner maintained steady breath support across the vowel nucleus or faded out immediately after onset (`intensity_drop_db < -8 dB` from onset to offglide).
3. **Duration & Speaking Rate Ratio (`voiced_duration_ratio`):**
   * Ratio of learner usable voiced duration to target reference voiced duration ($T_{\text{learn}} / T_{\text{ref}}$), distinguishing clipped/rushed productions ($< 0.45\times$) from sustained holds.

---

### Tier 5: Neural Phonetic & Articulatory Comparison (Stretch / High-Precision Tier)

When local CPU/GPU or a warm worker is available, comparing the two audio waveforms in a pretrained representation space solves two problems that pure LPC formants cannot: **content verification** (did the learner actually say `/i/` vs. a consonant/noise?) and **speaker-invariant phonetic similarity**.

1. **Lightweight Phonetic Posteriorgrams / Goodness of Pronunciation (GOP) for [`ContentVerifier`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/audio/content.py):**
   * Using an ONNX-quantized `wav2vec2-base` / `HuBERT` / `Allosaurus` phone recognizer (~30 ms on CPU for a 1.5 s clip), extract frame-level phoneme posteriors $P(\phi \mid x)$ for both the target sample and learner sample:
     * **Target Posterior Score:** Mean posterior probability $P(\text{target\_vowel} \mid x_{\text{learn}})$ over the voiced nucleus.
     * **Competing Phoneme Detection (`nearest_competing_phone`):** Identifies *which* vowel the learner's sample sounded closest to if off-target (e.g., Target `/i/` heard as lax `/ɪ/` or `/e/`, or Target `/u/` heard as centralized `/ʊ/` or `/ə/`).
     * **Jensen–Shannon Divergence ($D_{\text{JS}}$):** Symmetric divergence between the phoneme posterior distribution of the target sample and the learner sample.
2. **SSL Layer-Wise Cosine Similarity (WavLM / HuBERT Mid-Layers):**
   * Intermediate transformer layers (layers 6–9 of `WavLM-Base+` or `HuBERT-Base`) are proven to encode **speaker-invariant phonetic structure** while stripping out speaker identity and room acoustics. DTW-aligned cosine similarity between $\mathbf{h}_{\text{learn}}^{(l)}$ and $\mathbf{h}_{\text{ref}}^{(l)}$ yields a single calibration-free pronunciation match score in $[0, 1]$.
3. **SPARC Articulatory Inversion Comparison ([Roadmap Section 4](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L131)):**
   * Passing both $x_{\text{ref}}(t)$ and $x_{\text{learn}}(t)$ through **SPARC** outputs 12 normalized EMA articulatory features (lip aperture, lip protrusion, jaw, tongue tip/blade/dorsum $X/Y$). Comparing the two inverted trajectories provides an *Estimated Articulation Delta* (kept strictly separate from measured acoustics/video per Roadmap rules).

---

## 3. Concrete Python Implementation Blueprint (`parselmouth` + `numpy`)

Below is a self-contained backend analyzer function that compares a learner waveform against a target reference waveform (or cached target profile) across **Tiers 1–4** using the dependencies already installed in the repo (`parselmouth`, `numpy`):

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

    # Compute Bark coordinates for onset and offglide to measure convergence vs. drift
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

    # Optional Cepstral Peak Prominence (CPP) via Praat PowerCepstrogram
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

## 4. How the Coaching Agent Uses These Comparisons (Evidence $\rightarrow$ Actionable Feedback)

Because our architecture requires **code-computed evidence fields** and forbids the LLM from inventing measurements ([`decision.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/decision.py), [`coaching.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/coaching.py)), each backend comparison metric maps to a concrete, human-friendly coaching insight:

| Backend Comparison Finding | Code Condition (Learner vs. Target Sample) | What the Agent Can Safely Tell the Learner |
| :--- | :--- | :--- |
| **Speaker-Normalized Match** | `bark_distance <= 1.0` (even if raw Hz differs due to pitch/VTL) | *"Your vowel resonance matched the target cleanly for your voice."* (Prevents false negatives for high/low voices!) |
| **Onset Search $\rightarrow$ Late Lock-in (`converged_late`)** | `onset_distance > 1.5` and `nucleus_distance <= 1.0` | *"You found the target shape halfway through the hold—try setting your lips before you start your voice."* |
| **Mid-Hold Drift (`faded_late`)** | `nucleus_distance <= 1.1` and `offglide_distance > 1.5` (`trajectory_drift_bark > 0.8`) | *"Your sound started right in the target area, then drifted near the end—try holding that lip shape steady until you stop."* |
| **Damped / Nasalized Resonance (`high_b1_damping`)** | `learner.b1_nucleus_hz > target.b1_nucleus_hz * 1.8` (and $B_1 > 240\text{ Hz}$) | *"The resonance was a little muffled—try directing a clear, open sound through your mouth."* |
| **Breathy / Unsteady Voicing (`low_hnr_or_cpp`)** | `learner.hnr_mean_db < 9.0` or `intensity_drop_db < -8.0` | *"Your voice faded out quickly—take a comfortable breath and use a steady, clear tone."* |
| **Pitch Instability (`high_f0_iqr`)** | `learner.f0_iqr_st > 3.5` during a steady vowel task | *"Your pitch moved up and down during the vowel—try holding one comfortable, steady note."* |

---

## 5. Recommended Prioritization for Implementation

1. **Immediate High-Impact Upgrade (Pure Python / `parselmouth`, 0 new dependencies):**
   * Add **$F_3$ extraction** and **Bark-difference ($Z_3 - Z_1, Z_3 - Z_2$) speaker normalization** alongside the existing $F_1/F_2$ scorer in [`scoring.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/scoring.py) and [`features.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/features.py).
   * Add **3-phase segmentation (Onset / Nucleus / Offglide)** so `score_audio` scores the **steady nucleus ($20\text{–}80\%$)** rather than letting onset/offset transients skew the median, and exposes `trajectoryPattern: "steady" | "converging" | "drifting"` to the agent.
2. **Second Upgrade (Phonation & Resonance Telemetry):**
   * Extract `hnrMeanDb`, `b1MedianHz` (formant bandwidth), and `f0SpreadSt` (pitch steadiness) from `parselmouth` so the agent can distinguish placement errors from breathiness, pitch wobble, or damping.
3. **Third Upgrade (Direct Target-Waveform Reference Comparison):**
   * Run `analyze_voice_sample()` once on each cached Cartesia/clinician target reference audio file at startup to build a canonical `TargetVoiceProfile`, and compute deltas against the reference profile on every learner attempt.

