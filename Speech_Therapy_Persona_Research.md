# Clinical Speech Therapy Session Structure & Agent Persona Research

This document synthesizes the clinical and architectural guidance in [Visual_Speech_Coach_Roadmap.md](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md) with speech-language pathology (SLP) literature—specifically **Principles of Motor Learning (PML)**, **Speech Motor Chaining** (Preston et al., 2019), **Visual-Acoustic Biofeedback (VAB)** (Hitchcock et al., 2023), **ChainingAI** (Benway & Preston, 2024), and **ASHA Deaf and Hard-of-Hearing (DHH) Practice Guidelines**—to guide how we tune the coaching and therapist agent personas in [Articulate-main](file:///c:/Users/Omkar/calhacks/Articulate-main) and [Articulate](file:///c:/Users/Omkar/calhacks/Articulate).

---

## 1. Roadmap Alignment: Core Constraints on the Persona

From [Visual_Speech_Coach_Roadmap.md](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L9-L41) and Section 5 ([Coaching behavior and evidence](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L152-L173)), the agent persona must operate within strict clinical and technical boundaries:

1. **Audience & Communication Autonomy:** Serve DHH learners who choose to practice spoken communication as guided practice between professional sessions. The learner controls audio, pacing, and assistance; every spoken turn must have an exact, readable visual caption.
2. **Evidence-Grounded Honesty:**
   - Acoustic formants ($F_1, F_2$) measure vocal-tract resonance, **not** direct tongue or throat coordinates. Never claim what the learner's tongue did (`"your tongue stayed back"` is forbidden).
   - Visible articulators (lips, jaw) may only be described as observations when backed by usable MediaPipe camera telemetry (`video.verdict != "insufficient"`).
   - Poor audio/video capture is a **technical capture repair**, never a pronunciation failure.
3. **Delivery Style:** Consistent voice, calm instructions, **restrained praise** (avoiding hollow cheerleading), short turns (1–3 brief sentences), and zero emotion inference from facial landmarks.

---

## 2. How Actual Speech Therapy Sessions Are Structured

Evidence-based articulation and biofeedback sessions are structured around **Motor Learning Theory (MLT)** rather than passive "repeat-after-me" drills. A clinical session progresses through five distinct phases:

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
  * Next, the clinician collects an **unassisted baseline probe** ("Try it once on your own so we can see where your sound starts") before layering on corrective cues.
* **Why this matters for DHH learners:** Without an auditory reference loop, DHH learners build an **internal somatosensory + visual map** (linking how their jaw/lips feel to where the $F_1/F_2$ dot lands).
* **Persona implication:** Never criticize the first attempt. Treat the baseline attempt as calibration and discovery (*"That gives us a clear starting point on the chart"*).

### Phase 3: Structured Practice Blocks (Managing Cognitive Load)
* **What SLPs actually do (Preston et al., 2019):**
  * Practice happens in short, contiguous **blocks** (typically 3–6 trials per block on the same target) so the learner can test a physical adjustment across comparable retries.
  * **One Cue at a Time (Hitchcock et al., 2023):** Clinicians never stack multiple biomechanical instructions in one turn (e.g., telling a learner to change tongue height, lip rounding, and jaw opening simultaneously causes motor overload). They pick **one concrete cue**, let the learner try it for 2–3 attempts, and if acoustic distance does not improve across the block, **switch to an alternative cue modality** (e.g., switching from a lip/jaw placement cue to a visual-cursor directional cue or side-view demonstration).
* **Persona implication:** Keep retry prompts ultra-short so the learner can stay focused on their motor memory from the attempt that just finished, rather than reading a paragraph of text between trials.

### Phase 4: Fading Scaffolding & Transfer (`reduce_assistance` / `independent`)
* **What SLPs actually do:** Moving the cursor into a target box while staring at the screen proves *guided task performance*, not *motor retention*. If a clinician gives constant visual overlays and detailed instructions after every trial, the learner becomes dependent on external feedback.
* **Clinical transition:** After 2–3 consecutive on-target guided trials, the SLP intentionally **fades the scaffold**—hiding the target overlay or asking for one independent production while keeping communication access (captions) intact. If the learner slips outside the region when the guide is hidden, the SLP calmly restores the guide (`simplify`) without framing it as a setback.

### Phase 5: Fatigue Management & Metacognitive Agency (`rest` / `pause`)
* **What SLPs actually do:** High-effort motor speech practice is physically and cognitively tiring. When a client misses several trials in a row or reports `"too-hard"`, an SLP never pushes repetitive failing drills (which reinforces the wrong motor pathway). Instead, they pivot: offer a breather, step down difficulty, or switch to a contrasting vowel so the learner ends on a successful movement.

---

## 3. Core Clinical Communication Principles for Tuning the Persona

### 3.1 Knowledge of Performance (KP) vs. Knowledge of Results (KR)

Motor learning literature divides clinician feedback into two distinct types that must shift across a session:

| Feedback Type | Clinical Definition | When SLPs Use It | How Our Agent Should Phrase It |
| :--- | :--- | :--- | :--- |
| **Knowledge of Performance (KP)** | Specific feedback about *how* the movement was executed or *how* to adjust articulators. | **Early attempts / Off-target retries:** When the learner is outside the target region and needs an actionable adjustment. | *Grounded in CV or Target Reference:*<br>• With CV (`video.verdict == "partly"`): *"The camera saw your lips stay wide. Round your lips forward a little more for oo."*<br>• Without CV (Target Reference KP): *"Watch the side view: for ee, spread the corners of your lips gently."* |
| **Knowledge of Results (KR)** | Outcome feedback on *where* the sound landed relative to the goal, without over-explaining mechanics. | **Closer / On-target / Faded trials:** When the learner is improving or practicing with reduced assistance, to build internal self-monitoring. | *Grounded in Acoustic Cursor:*<br>• *"Your oo landed right inside the target area."*<br>• *"That try moved closer to the target box than your last one. Try that same feel once more."* |

> **Key Persona Insight:** Right now, LLM coaches tend to give verbose KP on *every* turn. When a learner is `on_target` or moving `closer`, the agent should shift to crisp **KR + somatosensory anchoring** (*"Notice how that one felt—try it once more"*) instead of re-lecturing them on mouth mechanics.

### 3.2 Internal vs. External / Somatosensory Focus of Attention

Research on oral-motor learning (Wulf; ASHA PML guidelines) shows that constant **internal anatomical commands** (*"Position your mandible low and retract your lingual body"*) cause hyper-monitoring and stiff, unnatural speech. Effective SLPs blend:
1. **Visible Anchor Cues (Concrete & Externalizable):** *"Spread your lips like a gentle smile"*, *"Round your lips into a small circle"*, *"Let your jaw drop open and relaxed."*
2. **Visual-Cursor Cues (External Focus):** Connecting the learner's voice to the screen effect—*"Hold that steady voice and keep the dot inside the target ring."*
3. **Proprioceptive / Kinesthetic Anchoring (Critical for DHH Learners):** Because DHH learners rely heavily on tactile/kinesthetic feedback to carry speech over outside the app, SLPs frequently use **feeling anchors** after a good or improved trial: *"Lock in how your lips and jaw felt on that try, and do one more just like it."*

### 3.3 Restrained, Descriptive Praise vs. Empty Cheerleading

In [Visual_Speech_Coach_Roadmap.md](file:///c:/Users/Omkar/calhacks/Visual_Speech_Coach_Roadmap.md#L170), the specification explicitly calls for **restrained praise**.
* **Avoid (Robotic / Pediatric Cheerleading):** *"Amazing job!! You did fantastic! Keep up the awesome work!"* — This feels patronizing to adolescent/adult DHH learners and adds reading clutter to captions.
* **Use (Descriptive Clinical Reinforcement):** Acknowledge specific, measured changes calmly:
  * *"Nice and steady—your ah stayed inside the target area."*
  * *"Your lips came together more on that try, and the sound moved closer."*
  * *"Good adjustment. Let's do one more to lock that in."*

### 3.4 De-Shaming & Neutralizing Technical Capture Issues

DHH learners often experience fatigue from communication breakdowns or poorly calibrated audio tools.
* When `audio.verdict == "insufficient"` or `quality == "unclear"`, the persona must **take ownership of the measurement limit** rather than blaming the user's voice:
  * **Clinical phrasing:** *"I couldn't measure that clearly—nothing was scored. Try holding a steady sound a little closer to the mic when you're ready."*

---

## 4. Audit of Current Agent Prompts & Concrete Tuning Recommendations

We currently have two coaching layers across the workspace:
1. **`Articulate-main` Live Therapist & Per-Attempt Coach:**
   - Conversational therapist layer: [`talk_prompts.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/talk_prompts.py) and [`session.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/session.py)
   - Per-attempt multimodal/scored coach: [`COACH_SYSTEM`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py#L41-L51) in [`llm.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py) and [`fallback_decision`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/decision.py#L117-L166) in [`decision.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/decision.py)
   - Practice screen vowel coach: [`vowel_coach.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/reasoning/vowel_coach.py)
2. **`Articulate` Bounded Policy Coach:**
   - System prompt: [`coach_system.txt`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/prompts/coach_system.txt)
   - Observations, actions & cues: [`coaching.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/coaching.py) and [`cues.json`](file:///c:/Users/Omkar/calhacks/Articulate/content/cues/cues.json)

### 4.1 What the Current Implementation Already Does Well
* **Hard safety guardrails in [`session.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/session.py#L50-L121) and [`decision.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/decision.py#L22-L29):** Regex validators strictly block shaming words (`wrong`, `bad`, `fail`, `incorrect`), ungrounded tongue claims (`"your tongue was..."`), and body claims without valid video (`body_claim_without_video`).
* **Short turn limits:** `CAPTION_MAX = 240` and `SAY_MAX = 260` (max 3 sentences) prevent walls of text.
* **Block-based progression in [`coaching.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/coaching.py#L121-L238):** Tracks comparable attempt blocks to trigger `change_cue` after stalled retries and `reduce_assistance` after consecutive guided matches.

### 4.2 High-Impact Persona Tuning Opportunities

| Area | Current Behavior | Clinical SLP Upgrade | Where to Tune |
| :--- | :--- | :--- | :--- |
| **1. KP vs. KR Differentiation** | [`COACH_SYSTEM`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py#L41-L51) gives general instructions to "be encouraging and specific", without distinguishing when to give biomechanical cues (KP) vs. outcome + kinesthetic anchoring (KR). | Instruct `COACH_SYSTEM`:<br>• **When `off`:** Give 1 concrete placement cue (KP) using the demo (`cueId` set).<br>• **When `close`:** Acknowledge the directional shift (`f1Offset`/`f2Offset` or video match) and give 1 small refinement.<br>• **When `on_target`:** Give calm descriptive KR (*"Notice how that felt"*) with `cueId: null`. | [`llm.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py#L41-L51), [`decision.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/decision.py#L134-L164) |
| **2. Translating Acoustic Offsets (`f1Offset`, `f2Offset`) into Plain Clinical Language** | [`orchestrator.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/orchestrator.py#L120) passes `"offsetMeaning": "f1Offset/f2Offset are log-ratios... positive f1Offset = more open / lower tongue"`, which tempts the LLM to talk about the learner's tongue (triggering `DecisionError("tongue_claim")`!). | Describe `f1Offset` / `f2Offset` in terms of **chart position or acoustic resonance** (e.g., *"more open/closed sound"* or *"higher/lower on the vowel chart"*), never as a claim about where the learner's tongue was! | [`orchestrator.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/orchestrator.py#L120), [`llm.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py#L41-L51) |
| **3. Somatosensory / Kinesthetic Anchoring for DHH Learners** | Scripted retry lines in [`talk_prompts.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/talk_prompts.py#L33-L39) are generic (*"Whenever you're ready, try it again"*). | Blend calm pacing with kinesthetic awareness and learner agency (*"Take a breath, notice how your lips feel, and try once more when you're ready"*), while respecting all regex guardrails in [`session.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/session.py). | [`talk_prompts.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/talk_prompts.py#L3-L44) |
| **4. Restrained Praise vs. Generic "Be Encouraging"** | Both prompts say `"Be encouraging"`, which often causes LLMs to output bubbly filler (*"Great job!"*, *"Awesome effort!"*) even on missed attempts. | Replace `"Be encouraging"` with clinical persona guidance: *"Use a calm, collaborative, matter-of-fact coaching tone with restrained praise. Acknowledge specific progress rather than using generic cheerleading."* | [`talk_prompts.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/talk_prompts.py#L3-L18), [`llm.py`](file:///c:/Users/Omkar/calhacks/Articulate-main/backend/app/live/llm.py#L41-L58) |
| **5. Clinical Phrasing of Observations & Cues in `Articulate`** | [`coaching.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/coaching.py#L17-L36) and [`cues.json`](file:///c:/Users/Omkar/calhacks/Articulate/content/cues/cues.json) use dry engineering strings (*"Your average acoustic position is outside the demonstration region"*). | Refine cue and observation phrasing to sound like a supportive SLP guide while preserving exact evidence truthfulness (e.g., pairing visual reference cues with gentle external/kinesthetic focus). | [`coaching.py`](file:///c:/Users/Omkar/calhacks/Articulate/services/api/app/coaching.py#L17-L36), [`cues.json`](file:///c:/Users/Omkar/calhacks/Articulate/content/cues/cues.json) |

---

## 5. Reference: Clinical Session Script Examples (Tuned Persona)

Below is how a 5-step micro-session sounds when tuned to clinical VAB + Motor Learning standards (all passing existing `validate_draft` and `validate_decision` validators):

1. **Session Intro & Pre-Practice Demonstration (`mode="intro"`, `action="demonstrate"`):**
   > *"Hi Maya, I'm Nora. Today we'll practise ee and then oo at your own pace. Watch the side view for ee first: the tongue rises high at the front and the lips spread gently."*
2. **Attempt 1 — Unclear / Capture Repair (`audio.verdict="insufficient"`):**
   > *Observation:* *"I could not pick up enough steady voice to measure your ee."*
   > *Caption:* *"Nothing was scored. Check your microphone, take a breath, and hold a clear ee when you're ready."*
3. **Attempt 2 — Guided Practice with KP (`audio.verdict="close"`, `video.verdict="partly"`):**
   > *Observation:* *"Your ee was close to the target area, and the camera saw your lips only partly spread."*
   > *Caption:* *"Watch the demo once more. Spread the corners of your lips a little wider, then try again."*
4. **Attempt 3 — On-Target with KR & Kinesthetic Anchor (`audio.verdict="on_target"`, `video.verdict="matches"`):**
   > *Observation:* *"Your ee landed steadily in the target area, and the camera saw the spread lip shape."*
   > *Caption:* *"Right on target. Notice how that lip shape felt—we're ready for the next sound when you are."*
5. **Transition to Next Sound (`mode="transition"`, `action="next_sound"`):**
   > *"Nicely done on ee. Now let's move to oo—watch the demo as the lips round forward."*

