let busy = false;
const listeners = new Set<() => void>();

export function setCaptureBusy(next: boolean): void {
  if (busy === next) return;
  busy = next;
  for (const listener of listeners) listener();
}

export function isCaptureBusy(): boolean {
  return busy;
}

export function subscribeCaptureBusy(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
