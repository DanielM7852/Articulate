export type ConsoleTab = 'classroom' | 'live';

export type ConsoleLocation = {
  tab: ConsoleTab;
  /** Empty string means the whole class is selected. */
  learner: string;
  attempt: string;
  revision: string;
  command: string;
  demo: boolean;
};

const COMMAND_PREFIX = 'articulate.console.command.';

export function readLocation(hash = window.location.hash): ConsoleLocation {
  const raw = hash || '#/classroom';
  const [path, query = ''] = raw.split('?');
  const tab: ConsoleTab = path === '#/live' || path === '#/dashboard' ? 'live' : 'classroom';
  const params = new URLSearchParams(query);
  return {
    tab,
    learner: params.get('learner') ?? '',
    attempt: params.get('attempt') ?? '',
    revision: params.get('revision') ?? '',
    command: params.get('command') ?? '',
    demo: params.has('demo') || params.has('d'),
  };
}

export function locationHash(next: ConsoleLocation): string {
  const params = new URLSearchParams();
  if (next.learner) params.set('learner', next.learner);
  if (next.attempt) params.set('attempt', next.attempt);
  if (next.revision) params.set('revision', next.revision);
  if (next.command) params.set('command', next.command);
  if (next.demo) params.set('demo', '1');
  const query = params.toString();
  return `#/${next.tab}${query ? `?${query}` : ''}`;
}

export function writeLocation(next: ConsoleLocation, mode: 'push' | 'replace' = 'push'): void {
  const hash = locationHash(next);
  if (window.location.hash === hash) return;
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  if (mode === 'replace') window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function subscribeLocation(cb: (loc: ConsoleLocation) => void): () => void {
  const run = () => cb(readLocation());
  window.addEventListener('hashchange', run);
  window.addEventListener('popstate', run);
  return () => {
    window.removeEventListener('hashchange', run);
    window.removeEventListener('popstate', run);
  };
}

export function rememberCommand(key: string, revision: number, commandId: string): void {
  try {
    sessionStorage.setItem(`${COMMAND_PREFIX}${key}.${revision}`, commandId);
  } catch {
    /* the command still lives in the address for this step */
  }
}

export function rememberLearnerLabel(id: string, label: string): void {
  try {
    sessionStorage.setItem('articulate.console.learnerLabel', JSON.stringify({ id, label }));
  } catch {
    /* the address still has the profile id */
  }
}

export function learnerLabel(id: string): string {
  if (!id) return 'Whole class';
  try {
    const parsed = JSON.parse(sessionStorage.getItem('articulate.console.learnerLabel') ?? '') as { id?: string; label?: string };
    if (parsed.id === id && parsed.label) return parsed.label;
  } catch {
    /* fall through */
  }
  return 'Selected learner';
}

export function recallCommand(key: string, revision: number): string {
  try {
    return sessionStorage.getItem(`${COMMAND_PREFIX}${key}.${revision}`) ?? '';
  } catch {
    return '';
  }
}
