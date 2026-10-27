import { expect, test } from '../game/__tests__/harness';
import { phonesHttpBase, phonesWsUrl } from './phonesUrl';

const https = { protocol: 'https:', host: 'app.example.com', origin: 'https://app.example.com' };
const http = { protocol: 'http:', host: 'localhost:5173', origin: 'http://localhost:5173' };

test('phonesWsUrl: defaults to localhost when unset or blank', () => {
  expect(phonesWsUrl(undefined, https)).toBe('ws://127.0.0.1:8020/ws/phones');
  expect(phonesWsUrl('  ', https)).toBe('ws://127.0.0.1:8020/ws/phones');
});
test('phonesWsUrl: same-origin follows the page protocol', () => {
  expect(phonesWsUrl('same-origin', https)).toBe('wss://app.example.com/phones/ws');
  expect(phonesWsUrl(' same-origin ', http)).toBe('ws://localhost:5173/phones/ws');
});
test('phonesWsUrl: is case-sensitive and passes absolute URLs through', () => {
  expect(phonesWsUrl('Same-Origin', https)).toBe('Same-Origin');
  expect(phonesWsUrl(' wss://x.test/ws/phones ', https)).toBe('wss://x.test/ws/phones');
});

test('phonesHttpBase: defaults to localhost when unset or blank', () => {
  expect(phonesHttpBase(undefined, https)).toBe('http://127.0.0.1:8020');
  expect(phonesHttpBase('', https)).toBe('http://127.0.0.1:8020');
});
test('phonesHttpBase: same-origin uses the page origin under /phones', () => {
  expect(phonesHttpBase('same-origin', https)).toBe('https://app.example.com/phones');
  expect(phonesHttpBase('same-origin', http)).toBe('http://localhost:5173/phones');
});
test('phonesHttpBase: passes absolute URLs through', () => {
  expect(phonesHttpBase(' https://x.test ', https)).toBe('https://x.test');
});
