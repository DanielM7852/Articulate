import './fillers.test';
import './sentences.test';
import './actions.test';
import './realtimeSession.test';
import { runQueueTests } from './utteranceQueue.test';
import { run } from '../../game/__tests__/harness';

run();
await runQueueTests();
