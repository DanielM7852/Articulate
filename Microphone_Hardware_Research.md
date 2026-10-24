# Microphone Hardware & Acoustic Capture Research: Visual Speech Coach

This report evaluates microphone hardware, acoustic physics, physical placement, and browser Web Audio settings for the **Visual Speech Coach**, balancing three strict project constraints:
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
   * In [`useMicrophone.ts`](file:///c:/Users/Omkar/calhacks/Articulate-main/web/src/audio/useMicrophone.ts#L99-L106) (`Articulate-main`), all three WebRTC filters are properly disabled:
     ```ts
     audio: {
       deviceId: deviceId ? { exact: deviceId } : undefined,
       echoCancellation: false,
       noiseSuppression: false,
       autoGainControl: false,
     }
     ```
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

