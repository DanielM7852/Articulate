import { expect, test } from '../../game/__tests__/harness';
import type { WordAttemptResult, ZoneResult } from '../../game/types';
import type { GhostUnit } from '../../game/ghost/types';
import {
  PHONE_HIT_POST,
  PHONE_PARTIAL_POST,
  PHONE_RESCUE_REASONS,
  RESCUE_MIN_CLIP_MS,
  applyPhoneJudgement,
  canPhoneRescue,
  clipOffsetMs,
  parsePhoneResponse,
  scorePhones,
  unitPhoneZones,
  isLoneVowelUnit,
  loneVowelVerdict,
  verdictFromScore,
  type PhoneScoreResponse,
} from '../phoneJudge';

const zone = (zoneId: string, phoneme: string, kind: ZoneResult['kind'], extra: Partial<ZoneResult> = {}): ZoneResult => ({
  zoneId,
  phoneme,
  kind,
  verdict: 'hit',
  dwellMs: 0,
  startMs: 1,
  endMs: 2,
  evidence: { burstDetected: 1 },
  ...extra,
});
const result = (over: Partial<WordAttemptResult> = {}): WordAttemptResult => ({
  word: 'track',
  attemptId: 'a1',
  durationMs: 900,
  quality: 'usable',
  lipUsable: false,
  zones: [zone('t', 't', 'stop'), zone('r', 'r', 'liquid', { advisory: true }), zone('a', 'ae', 'vowel'), zone('k', 'k', 'stop')],
  ...over,
});
const unit = (id: string, zoneIds: string[]): GhostUnit => ({ id, label: id, zoneIds, partIds: [] });
const tgt = (p: string, post: number, startMs = 300, endMs = 380, gop = 1) => ({ p, startMs, endMs, peakMs: startMs + 20, post, gop, best: p, bestPost: post });
const resp = (targets: ReturnType<typeof tgt>[]): PhoneScoreResponse => ({ targets, phones: [] });
const full = unit('track', ['t', 'r', 'a', 'k']);
const verdictOf = (r: WordAttemptResult, id: string) => r.zones.find((z) => z.zoneId === id)!.verdict;

test('phone thresholds map post to hit/partial/miss (gop positive)', () => {
  const u = unit('track', ['t', 'r', 'a', 'k']);
  const at = (post: number) =>
    verdictOf(applyPhoneJudgement(result(), u, resp([tgt('t', 0.9), tgt('ɹ', 0.9), tgt('æ', post), tgt('k', 0.9)]), 0), 'a');
  expect(at(PHONE_HIT_POST)).toBe('hit');
  expect(at(0.99)).toBe('hit');
  expect(at(PHONE_HIT_POST - 0.01)).toBe('partial');
  expect(at(PHONE_PARTIAL_POST)).toBe('partial');
  expect(at(0)).toBe('partial'); // vowel with gop 1 > -4 stays lenient
  const stop = (post: number) => verdictOf(applyPhoneJudgement(result(), unit('t', ['t']), resp([tgt('t', post)]), 0), 't');
  expect(stop(PHONE_PARTIAL_POST - 0.01)).toBe('miss');
});

const calib = (kind: ZoneResult['kind'], post: number, gop: number) => verdictFromScore(post, gop, kind);

test('calibration: real "track" is all hit', () => {
  expect(calib('stop', 0.93, 2.7)).toBe('hit');
  expect(calib('liquid', 1.0, 9.3)).toBe('hit');
  expect(calib('vowel', 0.99, 5.4)).toBe('hit');
  expect(calib('stop', 1.0, 10.5)).toBe('hit');
});

test('calibration: "tack" misses only the r', () => {
  expect(calib('stop', 0.96, 3.3)).toBe('hit');
  expect(calib('liquid', 0.0, -2.0)).toBe('miss');
  expect(calib('vowel', 0.96, 3.2)).toBe('hit');
  expect(calib('stop', 1.0, 10.2)).toBe('hit');
});

test('calibration: accents and weak phones', () => {
  expect(calib('vowel', 0.03, -3.9)).toBe('partial');
  expect(calib('vowel', 0.0, -7.4)).toBe('miss');
  expect(calib('stop', 0.47, -0.1)).toBe('partial');
  expect(calib('stop', 0.03, -3.9)).toBe('miss'); // leniency is vowels only
});

test('applyPhoneJudgement uses gop and the zone kind', () => {
  const r = applyPhoneJudgement(result(), unit('a', ['a']), resp([tgt('æ', 0.03, 300, 380, -3.9)]), 0);
  expect(verdictOf(r, 'a')).toBe('hit'); // lone vowel part: partial counts as hit
  const whole = applyPhoneJudgement(result(), full, resp([tgt('t', 0.9), tgt('ɹ', 0.9), tgt('æ', 0.03, 300, 380, -3.9), tgt('k', 0.9)]), 0);
  expect(verdictOf(whole, 'a')).toBe('partial');
});

test('lone vowel part: partial counts as hit, a real miss stays a miss', () => {
  const a = unit('a', ['a']);
  const at = (post: number, gop: number, u = a, res = result()) => {
    const targets = unitPhoneZones('track', u).map((z) => (z.zoneId === 'a' ? tgt('æ', post, 300, 380, gop) : tgt(z.phone, 0.9)));
    return verdictOf(applyPhoneJudgement(res, u, resp(targets), 0), 'a');
  };
  expect(at(0.16, -1.26)).toBe('hit');
  expect(at(0.05, -6)).toBe('miss');
  expect(at(0.05, -3)).toBe('hit'); // gop > -4
  expect(at(0.16, -1.26, full)).toBe('partial'); // same score in the whole word stays strict
  expect(at(0.9, 1, full)).toBe('hit');
  expect(loneVowelVerdict(0.16, -1.26)).toBe('hit');
  expect(loneVowelVerdict(0.05, -6)).toBe('miss');
  expect(isLoneVowelUnit(a, result().zones)).toBe(true);
  expect(isLoneVowelUnit(full, result().zones)).toBe(false);
  expect(isLoneVowelUnit(unit('k', ['k']), result().zones)).toBe(false);
});

test('consonant parts keep the strict rule', () => {
  const k = unit('k', ['k']);
  const at = (post: number, gop: number) => verdictOf(applyPhoneJudgement(result(), k, resp([tgt('k', post, 300, 380, gop)]), 0), 'k');
  expect(at(0.16, -1.26)).toBe('partial');
  expect(at(0.47, -0.1)).toBe('partial');
  expect(at(0.05, -6)).toBe('miss');
  expect(at(0.5, 0)).toBe('hit');
});

test('only the unit zones change and advisory/kind are kept', () => {
  const r = applyPhoneJudgement(result(), unit('tr', ['t', 'r']), resp([tgt('t', 0.05, 300, 380, -5), tgt('ɹ', 0.9)]), 0);
  expect(verdictOf(r, 't')).toBe('miss');
  expect(verdictOf(r, 'r')).toBe('hit');
  expect(r.zones.find((z) => z.zoneId === 'r')!.advisory).toBe(true);
  expect(r.zones.find((z) => z.zoneId === 'r')!.kind).toBe('liquid');
  expect(JSON.stringify(r.zones.find((z) => z.zoneId === 'a'))).toBe(JSON.stringify(result().zones[2]));
  expect(JSON.stringify(r.zones.find((z) => z.zoneId === 'k'))).toBe(JSON.stringify(result().zones[3]));
  expect(unitPhoneZones('track', unit('tr', ['t', 'r'])).map((z) => z.phone).join()).toBe('t,ɹ');
  expect(unitPhoneZones('sheep', unit('p', ['p'])).map((z) => z.phone).join()).toBe('p');
  expect(unitPhoneZones('nope', unit('p', ['p'])).length).toBe(0);
});

test('unclear results are returned unchanged', () => {
  const r = result({ quality: 'unclear', qualityReason: 'silence' });
  expect(applyPhoneJudgement(r, unit('a', ['a']), resp([tgt('æ', 0.9)]), 0) === r).toBe(true);
});

const skippedZone = (id: string, ph: string, kind: ZoneResult['kind']): ZoneResult =>
  zone(id, ph, kind, { verdict: 'skipped', startMs: null, endMs: null, evidence: {} });
const unclearTrack = (reason: WordAttemptResult['qualityReason']): WordAttemptResult =>
  result({
    quality: 'unclear',
    qualityReason: reason,
    durationMs: 0,
    zones: [skippedZone('t', 't', 'stop'), skippedZone('r', 'r', 'liquid'), skippedZone('a', 'ae', 'vowel'), skippedZone('k', 'k', 'stop')],
  });

test('canPhoneRescue only for unclear no-voice / too-short', () => {
  expect(canPhoneRescue(unclearTrack('no-voice'))).toBe(true);
  expect(canPhoneRescue(unclearTrack('too-short'))).toBe(true);
  expect(canPhoneRescue(unclearTrack('clipped'))).toBe(false);
  expect(canPhoneRescue(unclearTrack('silence'))).toBe(false);
  expect(canPhoneRescue(unclearTrack(undefined))).toBe(false);
  expect(canPhoneRescue(result({ quality: 'usable' }))).toBe(false);
  expect(PHONE_RESCUE_REASONS.join()).toBe('no-voice,too-short');
  expect(RESCUE_MIN_CLIP_MS).toBe(1500);
});

test('rescue: 2 of 4 targets heard makes the try usable with phone verdicts', () => {
  const r0 = unclearTrack('no-voice');
  const r = applyPhoneJudgement(r0, full, resp([tgt('t', 0.9, 200, 260), tgt('ɹ', 0.05, 300, 380, -5), tgt('æ', 0.8), tgt('k', 0.02, 560, 640, -5)]), 0);
  expect(r === r0).toBe(false);
  expect(r.quality).toBe('usable');
  expect(r.durationMs).toBe(440); // the aligned span (200..640 ms), so the coach clip covers the whole word
  expect('qualityReason' in r).toBe(false);
  expect(verdictOf(r, 't')).toBe('hit');
  expect(verdictOf(r, 'r')).toBe('miss');
  expect(verdictOf(r, 'a')).toBe('hit');
  expect(verdictOf(r, 'k')).toBe('miss');
  expect(r.zones.find((z) => z.zoneId === 't')!.evidence.judgedByPhones).toBe(1);
  expect(r0.quality).toBe('unclear');
});

test('rescue: 1 of 4 heard leaves the try unchanged', () => {
  const r0 = unclearTrack('too-short');
  const r = applyPhoneJudgement(r0, full, resp([tgt('t', 0.9), tgt('ɹ', 0.05), tgt('æ', 0.0), tgt('k', 0.02)]), 0);
  expect(r === r0).toBe(true);
});

test('rescue: clipped and silence are never rescued', () => {
  const good = resp([tgt('t', 0.9), tgt('ɹ', 0.9), tgt('æ', 0.9), tgt('k', 0.9)]);
  for (const reason of ['clipped', 'silence'] as const) {
    const r0 = unclearTrack(reason);
    expect(applyPhoneJudgement(r0, full, good, 0) === r0).toBe(true);
  }
});

test('evidence is merged, finite and within 24 keys', () => {
  const heavy: Record<string, number> = {};
  for (let i = 0; i < 24; i++) heavy[`k${i}`] = i;
  const r0 = result({ zones: [zone('t', 't', 'stop', { evidence: heavy })] });
  const bad = { ...tgt('t', 0.7), gop: NaN };
  const r = applyPhoneJudgement(r0, unit('tr', ['t']), resp([bad]), 0);
  const ev = r.zones[0].evidence;
  expect(Object.keys(ev).length <= 24).toBe(true);
  expect(Object.values(ev).every(Number.isFinite)).toBe(true);
  expect(ev.judgedByPhones).toBe(1);
  expect(ev.phonePost).toBe(0.7);
  expect('phoneGop' in ev).toBe(false);
  const small = applyPhoneJudgement(result(), unit('ck', ['k']), resp([tgt('k', 0.6)]), 0).zones[3].evidence;
  expect(small.burstDetected).toBe(1);
  expect(small.phoneBestPost).toBe(0.6);
});

test('offset maps clip times to attempt time and clamps', () => {
  const r = applyPhoneJudgement(result(), unit('a', ['a']), resp([tgt('æ', 0.9, 500, 620)]), 200);
  const z = r.zones[2];
  expect(z.startMs).toBe(300);
  expect(z.endMs).toBe(420);
  expect(z.dwellMs).toBe(120);
  const early = applyPhoneJudgement(result(), unit('a', ['a']), resp([tgt('æ', 0.9, 100, 150)]), 200).zones[2];
  expect(early.startMs).toBe(0);
  expect(early.endMs).toBe(0);
  expect(early.dwellMs).toBe(0);
  expect(clipOffsetMs(1750, result(), 400)).toBe(450);
  expect(clipOffsetMs(500, result(), 400)).toBe(0);
});

test('malformed responses parse to null', () => {
  expect(parsePhoneResponse(null)).toBe(null);
  expect(parsePhoneResponse({})).toBe(null);
  expect(parsePhoneResponse({ targets: [{ p: 't' }] })).toBe(null);
  expect(parsePhoneResponse({ targets: [{ p: 't', post: 'x', startMs: 0, endMs: 1 }] })).toBe(null);
  const ok = parsePhoneResponse({ targets: [{ p: 't', post: 2, startMs: 0, endMs: 1 }], phones: [] });
  expect(ok?.targets[0].post).toBe(1);
});

// The harness runs sync cases only, so the I/O cases settle first (top-level await) and the test asserts the outcomes.
const clip = { format: 'wav' as const, data: 'AAAA', durationMs: 100 };
const mk = (impl: () => Promise<Response>) => ({ fetchImpl: (async () => impl()) as unknown as typeof fetch, baseUrl: 'http://x' });
const net = {
  bad: await scorePhones(clip, ['t'], mk(async () => new Response('no', { status: 404 }))),
  boom: await scorePhones(clip, ['t'], mk(async () => Promise.reject(new Error('down')))),
  junk: await scorePhones(clip, ['t'], mk(async () => new Response('{"x":1}', { status: 200 }))),
  good: await scorePhones(clip, ['t'], mk(async () => new Response(JSON.stringify({ targets: [tgt('t', 0.8)], phones: [] }), { status: 200 }))),
  hang: await scorePhones(clip, ['t'], {
    timeoutMs: 20,
    baseUrl: 'http://x',
    fetchImpl: ((_u: unknown, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch,
  }),
};

test('scorePhones returns null on failure/timeout and parses a good response', () => {
  expect(net.bad).toBe(null);
  expect(net.boom).toBe(null);
  expect(net.junk).toBe(null);
  expect(net.hang).toBe(null);
  expect(net.good?.targets[0].post).toBe(0.8);
});
