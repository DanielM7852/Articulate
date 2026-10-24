# Limitations

This is the state of the first backend milestone: two recordings can be measured, one curated cue can be chosen, and the response contains a short line Cartesia can speak.

- Without a Cartesia key, the prepared reference is a synthetic harmonic phrase. With a key, that reference is one Cartesia reading of the transcript. Either way it is one example, not a human learner recording and not a standard for every voice or dialect. The measured ending still has to match the intended pattern before the learner is coached.
- The repository had no learner recordings, so the extractor tests use labeled synthetic audio. The automated suite, including those synthetic recording cases, passed in this workspace. That is not an accuracy measurement on human speech, and no benchmark number is claimed.
- Pitch tracking is librosa pYIN. Praat's current preference for intonation is filtered autocorrelation. pYIN is a different method. Suspected octave frames are withheld rather than corrected. Parselmouth is not integrated.
- Detector voicing probability is not pronunciation quality. F0 is not tongue, lip, or jaw position. The service rejects coaching text that makes those claims.
- No speech recognizer is configured. `content_verified` stays false, and the coaching text must not claim the learner said the phrase.
- Comparison thresholds are engineering defaults for short fixed phrases. They are not validated clinical cutoffs.
- Seed cues are unreviewed drafts. A retrieved cue is not a clinical recommendation.
- Constrained DTW is used only for duration ratios outside ±15% when a Sakoe-Chiba band of at most 0.45 can connect the sequences. It is not a general pronunciation aligner. Word and syllable times are not available yet.
- Live Claude and live Moss were not called in the automated tests. Without credentials, retrieval and coaching use disclosed fallbacks.
- Cartesia speaks the prepared reference when a key is set, and the coaching line is still only a handoff example. This process does not open a second voice agent.
- The local session store is one JSON file per session on one machine. It does not retain raw audio. Duplicate attempt ids replay the first result. SpacetimeDB, when configured, stores profiles, progress, and compact curves for the caller's identity. See `docs/live-metrics.md`. Unconfigured runs do not write that database.
- Cancellation is checked between stages. A pitch extraction already running in a worker finishes, and its result is discarded if a newer attempt has taken the session.
- The first pYIN call in a process pays Numba compilation time. Timeouts are configurable because of that.
- Progress events describe this process only.
