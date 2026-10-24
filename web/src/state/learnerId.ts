// A stable, anonymous per-device learner id. Sign-in was removed, so this is the profile id the live
// coaching backend keys on. Format `learner-<12 hex>` is valid for [A-Za-z0-9_.:@-]{1,64}.
const KEY = 'articulate.learnerId';
const VALID = /^[A-Za-z0-9_.:@-]{1,64}$/;

let memo: string | null = null;

function makeId(): string {
  const bytes = new Uint8Array(6);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `learner-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function learnerProfileId(): string {
  if (memo) return memo;
  let id: string | null = null;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored && VALID.test(stored)) id = stored;
  } catch {
    /* storage blocked: fall back to memory */
  }
  if (!id) {
    id = makeId();
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* in-memory only */
    }
  }
  memo = id;
  return id;
}
