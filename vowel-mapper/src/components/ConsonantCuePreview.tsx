import { useState } from 'react';
import './consonant-cues.css';

/** A representation study only: no microphone inference and no F1/F2 coordinates. */
export function ConsonantCuePreview() {
  const [enabled, setEnabled] = useState(false);
  const [word, setWord] = useState<'rent' | 'ween'>('rent');
  return <section className="consonant-preview" aria-label="Consonant representation prototype">
    <label className="consonant-toggle"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} />Consonant cue preview<span>Experimental · off by default</span></label>
    {enabled && <div className="consonant-example">
      <p>Scripted example only. These cues are not detected from your microphone.</p>
      <div className="consonant-word-options" aria-label="Example word">
        {(['rent', 'ween'] as const).map(example => <button type="button" key={example} aria-pressed={word === example} onClick={() => setWord(example)}>{example}</button>)}
      </div>
      <ol className="consonant-cue-lane" data-testid="consonant-cue-lane" aria-label={`Sound order in ${word}; spacing does not show duration`}>
        <li className="consonant-event"><strong>{word === 'rent' ? 'r' : 'w'}</strong><span>Consonant cue</span></li>
        <li className="consonant-vowel"><strong>{word === 'rent' ? 'eh' : 'ee'}</strong><span>Vowel on the map</span></li>
        <li className="consonant-event"><strong>n</strong><span>Consonant cue</span></li>
        {word === 'rent' && <li className="consonant-event"><strong>t</strong><span>Consonant cue</span></li>}
      </ol>
      <p>Sound order →&nbsp; Consonants get a cue in this lane, with no vowel position. Live tracking can still mistake a consonant for a vowel; this preview does not change tracking.</p>
    </div>}
  </section>;
}
