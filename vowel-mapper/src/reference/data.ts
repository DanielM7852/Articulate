// Generated from experiments/target-scaling/results/reference-h95-tracker-v1.json. Do not edit by hand.
/** Hillenbrand et al. (1995) vowels re-measured by this tracker; natural-log Hz. Experimental, not a correctness standard. */
export const REFERENCE_V1 = {
  id: 'h95-tracker-scaled', version: 1, k: 2.0,
  means: {iy: [6.04434, 7.89291], eh: [6.52312, 7.61913], ae: [6.54224, 7.67392], ah: [6.74716, 7.31818], uw: [6.30819, 7.24547], er: [6.28786, 7.33198]},
  radius: {iy: [0.14445, 0.10960], ah: [0.14396, 0.16764], uw: [0.67406, 0.70729]},
  estimatorSha256: 'cd8feb87a323b741a3e283ed5af96c647b24f597752b608d7e9b1a030df3cc94',
} as const;

// Generated from experiments/target-scaling/results/voice-size-v1.json (Amendment 3). Do not edit by hand.
/** Voice sizing without the check words: one held "uh" plus a chosen voice group. Exploratory; natural-log Hz. */
export const VOICE_SIZE_V1 = {
  id: 'h95-tracker-voice-size', version: 1,
  uh: [6.56143, 7.23970],
  groupFactor: { men: -0.13793, women: 0.03970, boys: 0.07655, girls: 0.11792 },
} as const;
