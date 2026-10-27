Articulate main app improvement summary

Research summary October 27 2026

Prioritize reliable scoring, meaningful game targets and actionable visual feedback. The app already includes useful models; the next step is to connect their measurements to specific speech skills and handle uncertainty clearly.

This brief covers speech practice for deaf and hard of hearing (DHH) learners. The code findings refer to commit ca7af66. They identify likely failure points; recordings and clinician labels are needed to determine which causes dominate the reported false negatives.

# Make computer vision useful

Build a calibrated interactive mirror using the existing MediaPipe pipeline. Show the learner beside a synchronized reference, allow slow replay, and compare visible lip opening, rounding and closure over time. Calibrate against the learner's own comfortable movement range.

Use camera quality checks to explain poor framing, angle or lighting. Audio should supply fast release timing; the main camera loop is too slow to measure brief consonant events precisely.

| **Model or method** | **Useful role** | **Recommendation** |
| --- | --- | --- |
| MediaPipe Face Landmarker | Visible lip and jaw movement, pose and capture quality | Use now for the calibrated mirror |
| Small temporal classifier | Recognize movement sequences from landmarks | Train after collecting labeled examples |
| AV-HuBERT | Combine mouth video and audio in noise | Benchmark as a later research experiment |
| SPARC | Estimate articulation from recorded audio | Explore after attempts; label estimates clearly |
| ARTI-6 | Experimental internal vocal tract features | Defer corrective feedback based on these features |

A webcam cannot verify internal tongue or throat position. Similar lip closures occur in p, b and m. MediaPipe coefficients are not correctness scores, and SPARC plus formants does not independently verify anatomy. ARTI-6's inversion study used one speaker's MRI recordings.

Sources [<u>MediaPipe</u>](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker) | [<u>AV-HuBERT</u>](https://arxiv.org/abs/2201.01763) | [<u>SPARC</u>](https://arxiv.org/abs/2406.12998) | [<u>ARTI-6</u>](https://arxiv.org/html/2509.21447v1) | [<u>Reviewed repository</u>](https://github.com/DanielM7852/Articulate/blob/ca7af6631a3d1d92782b00f9791131f6a13a6e37/README.md)

# Reduce false negatives

Keep KoelLabs XLSR as the baseline while investigating the scoring pipeline. The repository already defaults to this model. A model change alone will not resolve recording gates, cursor behavior or fallback scoring.

| **Current behavior** | **Why it may reject a reasonable attempt** |
| --- | --- |
| Formants require RMS of 0.008 and periodicity of 0.65 | Quiet or irregularly voiced speech can lose formant measurements |
| Streaming recognition skips window RMS below 0.004 | Microphone gain and surrounding silence affect whether inference runs |
| Cursor requires nonblank CTC mass of at least 0.5 | CTC labels are often brief spikes, so the cursor can freeze during speech |
| A hit requires posterior at least 0.4 and GOP at least 0 | Shared thresholds may reject sounds or contexts the model finds less certain |
| Formant onset controls attempts and some rescue paths | Upstream detection failure can prevent evaluation by the phone scorer |

Separate speech detection, feature measurability and target achievement. Submit usable recordings for phone scoring even when formants fail. Offer manual recording, calibrate amplitude checks against noise and comfortable speech, and return an unscored result when evidence is unclear.

Use Silero VAD as supporting evidence rather than deleting all frames it rejects. Tune scoring per sound and task, compare intended sounds against plausible substitutions or omissions, and report service failures separately. Trial DeepFilterNet on a recognition branch while retaining original audio for acoustic measurements.

Validate with clinician-labeled correct, incorrect and ambiguous attempts across microphones, distances and noise. Compare full clips with streaming on held-out speakers. Track false rejection, false acceptance, the unscored rate and latency.

# Give game targets a clear meaning

The current phone map uses hand-authored positions and a recognition-driven cursor. Keep the circles and trails, but give each exercise a measurable coordinate system instead of presenting the path as tongue movement.

| **Practice goal** | **Target meaning** |
| --- | --- |
| Vowel contrasts | Measured F1 and F2 with speaker-appropriate acceptable regions |
| Word sequencing | A left-to-right timeline of sounds or syllables |
| Sustained sounds | A duration corridor for the selected measurable feature |
| Intonation and stress | Syllable progress and pitch relative to the learner's comfortable range |

Example: a pa exercise links lip closure, release and a following voiced vowel to three visible events. A ship versus sheep exercise instead teaches a vowel contrast. Personalization must not automatically label every enrollment production as correct.

Sources [<u>Estimator</u>](https://github.com/DanielM7852/Articulate/blob/ca7af6631a3d1d92782b00f9791131f6a13a6e37/vowel-mapper/src/audio/estimator.ts) | [<u>Phone judge</u>](https://github.com/DanielM7852/Articulate/blob/ca7af6631a3d1d92782b00f9791131f6a13a6e37/web/src/live/phoneJudge.ts) | [<u>Phone map</u>](https://github.com/DanielM7852/Articulate/blob/ca7af6631a3d1d92782b00f9791131f6a13a6e37/web/src/game/ghost/phoneMap.ts) | [<u>CTC behavior</u>](https://docs.pytorch.org/audio/master/tutorials/ctc_forced_alignment_api_tutorial.html) | [<u>KoelLabs</u>](https://huggingface.co/KoelLabs/xlsr-english-01) | [<u>Silero</u>](https://github.com/snakers4/silero-vad) | [<u>DeepFilterNet</u>](https://github.com/Rikorose/DeepFilterNet)

# Teach reviewed cues and speech techniques

Have a speech-language pathologist (SLP) select targets and approve cue sets with DHH learners. General articulation protocols need adaptation to the learner's speech profile, communication preferences and dialect. ASHA's general articulation portal does not cover hearing-loss-related speech difficulties within its main scope.

Structure practice around phonetic placement, facilitating syllables, modeling and imitation. Progress from watching, to producing together, to independent production. Use meaningful contrasts when appropriate, then build successful syllables into words, phrases and self-generated sentences.

Fade visual support and feedback as the learner improves. Check unpractised words and later retention so success reflects learning beyond the game. Acoustic biofeedback should show an understandable feature and an appropriate target.

| **Target** | **Example cue to review** | **Animation** |
| --- | --- | --- |
| p and b | Bring the lips together, then release into the vowel | Closure, release and voicing timing |
| f and v | Rest upper teeth lightly against the lower lip; keep air flowing; add voice for v | Teeth and lip close-up, airflow and vibration |
| m | Gently close the lips and hum | Closed lips, nasal airflow and voicing |
| t and d | Touch the ridge behind the upper teeth with the tongue tip, then release | Highlighted tongue contact and release |
| American English r | Demonstrate a selected bunched or retroflex configuration | Separate tongue variants and lateral bracing |

Extend the existing poses with dynamic closure and release, oral versus nasal airflow, voicing, labiodental contact and continuous sound transitions. Include pause, scrub, slow motion and repeat controls. SpeechSTAR and Seeing Speech provide useful imaging-based references.

Each agent cue should specify the sound and context, required evidence, permitted observation, suggested action, animation and review version. A teaching suggestion such as trying more lip rounding does not justify an unsupported claim about where the learner's tongue was.

# Recommended build order

1 Separate capture quality from pronunciation scoring and expose unscored results.
2 Replace the universal phone map with meaningful timelines and acoustic targets.
3 Add the calibrated mirror and synchronized comparison.
4 Introduce reviewed cue sets, feedback fading and independent practice.

Sources [<u>ASHA scope and approaches</u>](https://www.asha.org/practice-portal/clinical-topics/articulation-and-phonology/) | [<u>Modeling and cueing</u>](https://www.asha.org/practice-portal/clinical-topics/acquired-apraxia-of-speech/) | [<u>Motor chaining</u>](https://pmc.ncbi.nlm.nih.gov/articles/PMC6802861/) | [<u>r configurations</u>](https://pmc.ncbi.nlm.nih.gov/articles/PMC7842851/) | [<u>SpeechSTAR</u>](https://www.speechstar.ac.uk/) | [<u>Seeing Speech</u>](https://seeingspeech.ac.uk/) | [<u>f and v cues</u>](https://goldcoast.health.qld.gov.au/our-services/community-child-health/speak-with-me/practicing-speech-sounds/f-and-v-sounds) | [<u>Humming cue</u>](https://www.fhft.nhs.uk/patients-and-visitors/patient-information-library/oral-resonance-bringing-voice-forward/submit/7561)
