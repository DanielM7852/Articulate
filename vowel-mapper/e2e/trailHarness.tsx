import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { VowelPlot, type VowelPlotProps } from '../src/components/VowelPlot';

/** Real component with deterministic inputs, served only by the test dev server. */
export function mountTrail() {
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  const root = createRoot(host);
  const request = window.requestAnimationFrame.bind(window);
  const cancel = window.cancelAnimationFrame.bind(window);
  const pending = new Set<number>();
  window.requestAnimationFrame = (callback) => {
    const id = request((time) => { pending.delete(id); callback(time); });
    pending.add(id);
    return id;
  };
  window.cancelAnimationFrame = (id) => { pending.delete(id); cancel(id); };
  return {
    render: (props: VowelPlotProps) => root.render(createElement(VowelPlot, props)),
    pendingFrames: () => pending.size,
    visibility: (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
      document.dispatchEvent(new Event('visibilitychange'));
    },
    unmount: () => {
      root.unmount();
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
    },
  };
}

declare global {
  interface Window { trailHarness: ReturnType<typeof mountTrail> }
}
