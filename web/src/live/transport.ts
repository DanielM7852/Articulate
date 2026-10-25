/** Shared coordination uses a signed HttpOnly guest cookie, never a display-name identity. */
export interface LiveIdentity {
  shared: boolean;
  profileId: string | null;
}

let identity: Promise<LiveIdentity> | null = null;

export function getLiveIdentity(): Promise<LiveIdentity> {
  if (!identity) {
    identity = fetch('/v1/live/identity', { credentials: 'same-origin', signal: AbortSignal.timeout(3000) })
      .then(async (response) => {
        if (response.status === 404) return { shared: false, profileId: null }; // Older/local backend.
        if (!response.ok) throw new Error('Live identity unavailable');
        const value = (await response.json()) as LiveIdentity;
        if (typeof value.shared !== 'boolean' || (value.shared && typeof value.profileId !== 'string')) {
          throw new Error('Malformed live identity');
        }
        return value;
      })
      .catch((error: unknown) => {
        identity = null;
        throw error;
      });
  }
  return identity;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

/** A non-2xx reply from a live endpoint; `.message` keeps the historical "<url> failed (<status>)" text. */
export class LiveHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'LiveHttpError';
  }
}

/** Accept either the local synchronous response or a durable job from any API replica. */
export async function livePost<T>(url: string, input: object, signal?: AbortSignal): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60_000);
  const abort = () => ctl.abort();
  if (signal?.aborted) ctl.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const principal = await getLiveIdentity();
    const body = principal.shared ? { ...input, profileId: principal.profileId } : input;
    const idempotencyKey = crypto.randomUUID();
    let response = await fetch(url, {
      method: 'POST', credentials: 'same-origin', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    });
    let pollMs = 200;
    while (response.status === 202) {
      const job = (await response.json()) as { jobId: string };
      if (!/^[0-9a-f-]{36}$/i.test(job.jobId)) throw new Error('Malformed coaching job');
      // Back off and spread polling across clients as provider work takes longer.
      await pause(pollMs * (0.8 + Math.random() * 0.4), ctl.signal);
      pollMs = Math.min(1500, pollMs * 1.5);
      response = await fetch(`/v1/live/jobs/${job.jobId}`, { credentials: 'same-origin', signal: ctl.signal });
    }
    if (!response.ok) throw new LiveHttpError(response.status, `${url} failed (${response.status})`);
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
