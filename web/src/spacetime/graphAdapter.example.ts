/**
 * Example for the graph teammate. This file is not mounted in the practice screen.
 *
 * Local preview draws from the microphone immediately. Spacetime subscriptions
 * supply other devices and the verified result. Ignore chunks whose producerId
 * matches this device so the local preview is not drawn twice.
 *
 * Generated bindings live in ./module_bindings and were produced by
 * `spacetime generate --lang typescript` against the 2.13.0 module.
 */
import { DbConnection } from './module_bindings';

export type PreviewFrame = {
  time_s: number;
  f0_hz: number | null;
  voiced: boolean;
  valid: boolean;
};

export type GraphPhase = 'pending' | 'provisional' | 'verified' | 'partial' | 'failed' | 'synthetic_fixture';

export function drawLocalPreview(frames: PreviewFrame[]): PreviewFrame[] {
  return frames.filter((frame) => frame.valid && frame.f0_hz != null);
}

export function connectLearnerGraph(host: string, database: string, token: string, deviceId: string) {
  const conn = DbConnection.builder()
    .withUri(host)
    .withDatabaseName(database)
    .withToken(token)
    .build();
  conn.subscriptionBuilder().subscribe([
    'SELECT * FROM my_profile',
    'SELECT * FROM my_progress',
    'SELECT * FROM my_attempts',
    'SELECT * FROM my_active_chunks',
    'SELECT * FROM my_sessions',
  ]);
  return {
    connection: conn,
    /** Drop an echoed provisional chunk that this device just uploaded. */
    acceptChunk(producerId: string): boolean {
      return producerId !== deviceId;
    },
  };
}
