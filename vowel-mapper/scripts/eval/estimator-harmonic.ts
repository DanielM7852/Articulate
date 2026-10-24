/** For scripts/eval/run.ts --estimator: the production estimator with the harmonic noise-floor envelope on. */
import { DEFAULT_SETTINGS, estimateFormants as production } from '../../src/audio/estimator.ts';

export const estimateFormants = (frame: Float32Array, rate: number) => production(frame, rate, { ...DEFAULT_SETTINGS, harmonicEnvelope: true });
