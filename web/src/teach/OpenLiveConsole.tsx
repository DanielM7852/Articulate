import { useEffect } from 'react';

/** Compatibility route for the old system graph. The console lives on teach.html. */
export function OpenLiveConsole() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] ?? '');
    const demo = params.has('demo') || params.has('d') ? '?demo=1' : '';
    window.location.replace(`/teach.html#/live${demo}`);
  }, []);
  return <p className="lede">Opening the teaching console.</p>;
}
