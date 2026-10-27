/** Where the browser reaches the phone-recognition service. Pure so it can be tested. */

type Loc = Pick<Location, 'protocol' | 'host' | 'origin'>;

const SAME_ORIGIN = 'same-origin';
const DEFAULT_WS = 'ws://127.0.0.1:8020/ws/phones';
const DEFAULT_HTTP = 'http://127.0.0.1:8020';

function viteEnv(name: 'VITE_PHONES_WS' | 'VITE_PHONES_HTTP'): string | undefined {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.[name];
}

function pageLocation(): Loc {
  return window.location;
}

/** WebSocket URL. `same-origin` means the page's own host under /phones/ws (a deployed relay). */
export function phonesWsUrl(env: string | undefined = viteEnv('VITE_PHONES_WS'), loc?: Loc): string {
  const v = (env ?? '').trim();
  if (!v) return DEFAULT_WS;
  if (v === SAME_ORIGIN) {
    const l = loc ?? pageLocation();
    return `${l.protocol === 'https:' ? 'wss:' : 'ws:'}//${l.host}/phones/ws`;
  }
  return v;
}

/** HTTP base (no trailing slash); callers append /v1/phones/... */
export function phonesHttpBase(env: string | undefined = viteEnv('VITE_PHONES_HTTP'), loc?: Loc): string {
  const v = (env ?? '').trim();
  if (!v) return DEFAULT_HTTP;
  if (v === SAME_ORIGIN) return `${(loc ?? pageLocation()).origin}/phones`;
  return v;
}
