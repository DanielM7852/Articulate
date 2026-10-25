import { expect, test } from '../../game/__tests__/harness';
import { RealtimeSession } from '../realtimeSession';

type Msg = Record<string, unknown>;

function fake() {
  const s = new RealtimeSession();
  const sent: Msg[] = [];
  const priv = s as unknown as { dc: unknown; onServerMessage(raw: string): void };
  priv.dc = { readyState: 'open', send: (d: string) => sent.push(JSON.parse(d) as Msg), close() {} };
  const feed = (ev: Msg) => priv.onServerMessage(JSON.stringify(ev));
  return { s, sent, feed };
}

test('assistant message item per response and previous ids are tracked from server events', () => {
  const { s, feed } = fake();
  feed({ type: 'conversation.item.added', previous_item_id: 'u1', item: { id: 'a1', type: 'message', role: 'assistant' } });
  feed({ type: 'response.output_item.added', response_id: 'r1', item: { id: 'a1', type: 'message' } });
  feed({ type: 'response.output_item.added', response_id: 'r1', item: { id: 'fc1', type: 'function_call' } });
  expect(s.assistantItemFor('r1')).toBe('a1');
  expect(s.assistantItemFor('r2')).toBe(null);
});

test('assistant item is also learned from response.output_item.done', () => {
  const { s, feed } = fake();
  feed({ type: 'response.output_item.done', response_id: 'r3', item: { id: 'a3', type: 'message' } });
  expect(s.assistantItemFor('r3')).toBe('a3');
});

test('replaceAssistantText deletes then recreates at the old position with output_text', () => {
  const { s, sent, feed } = fake();
  feed({ type: 'conversation.item.added', previous_item_id: 'u1', item: { id: 'a1', type: 'message' } });
  feed({ type: 'response.output_item.added', response_id: 'r1', item: { id: 'a1', type: 'message' } });
  s.replaceAssistantText('a1', 'Nice try.');
  expect(sent.length).toBe(2);
  expect(JSON.stringify(sent[0])).toBe(JSON.stringify({ type: 'conversation.item.delete', item_id: 'a1' }));
  expect(sent[1].type).toBe('conversation.item.create');
  expect(sent[1].previous_item_id).toBe('u1');
  const item = sent[1].item as Msg;
  expect(/^item_[A-Za-z0-9]{1,27}$/.test(item.id as string)).toBe(true);
  expect(JSON.stringify({ ...item, id: undefined })).toBe(JSON.stringify({
    type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Nice try. —' }],
  }));
  expect(s.assistantItemFor('r1')).toBe(null);
});

test('replaceAssistantText with empty heard only deletes; unknown previous id skips the re-create', () => {
  const { s, sent } = fake();
  s.replaceAssistantText('a9', '');
  expect(sent.length).toBe(1);
  expect(sent[0].type).toBe('conversation.item.delete');
  s.replaceAssistantText('a8', 'Hi');
  expect(sent.length).toBe(2);
  expect(sent[1].type).toBe('conversation.item.delete');
});

test("replaceAssistantText re-creates the first item (previous id null) at 'root'", () => {
  const { s, sent, feed } = fake();
  feed({ type: 'conversation.item.added', previous_item_id: null, item: { id: 'a1', type: 'message' } });
  s.replaceAssistantText('a1', 'Hello there.');
  expect(sent.length).toBe(2);
  expect(sent[1].previous_item_id).toBe('root');
});

test('re-created item is re-pointed from followers; a second repair of the next item uses the new id', () => {
  const { s, sent, feed } = fake();
  feed({ type: 'conversation.item.added', previous_item_id: 'u1', item: { id: 'a1', type: 'message' } });
  feed({ type: 'conversation.item.added', previous_item_id: 'a1', item: { id: 'u2', type: 'message' } });
  feed({ type: 'conversation.item.added', previous_item_id: 'u2', item: { id: 'a2', type: 'message' } });
  s.replaceAssistantText('a1', 'First part.');
  const newId = (sent[1].item as Msg).id as string;
  s.replaceAssistantText('a2', 'Second part.');
  expect(sent[3].previous_item_id).toBe('u2');
  // Repair the already re-created item again: its own position is known and u2 now follows the newest id.
  s.replaceAssistantText(newId, 'First');
  expect(sent[4].item_id).toBe(newId);
  expect(sent[5].previous_item_id).toBe('u1');
  expect((sent[5].item as Msg).id === newId).toBe(false);
});

test('delete-only re-points followers to the deleted item predecessor', () => {
  const { s, sent, feed } = fake();
  feed({ type: 'conversation.item.added', previous_item_id: 'u1', item: { id: 'a1', type: 'message' } });
  feed({ type: 'conversation.item.added', previous_item_id: 'a1', item: { id: 'u2', type: 'message' } });
  feed({ type: 'conversation.item.added', previous_item_id: 'u2', item: { id: 'a2', type: 'message' } });
  s.replaceAssistantText('a1', '');
  // u2 followed a1; now it follows u1, so repairing u2 re-creates at u1.
  s.replaceAssistantText('u2', 'Hi');
  expect(sent[1].type).toBe('conversation.item.delete');
  expect(sent[2].previous_item_id).toBe('u1');
});
