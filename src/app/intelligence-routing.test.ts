import { expect, it } from 'vitest';
import { PageOutlet } from './App';
import { parseRoute } from './routing';
import { TransientRetrieval } from './transient-retrieval';
import { ConversationPanel } from './conversation-panel';

it('passes only the validated chat identity into the conversation outlet', () => {
  const props = { exchange: new TransientRetrieval(), onResult: () => {}, onInvalidateResult: () => {} };
  const route = parseRoute('#conversation?chatId=synthetic-chat');
  const element = PageOutlet({ ...props, route });
  expect(element?.type).toBe(ConversationPanel);
  expect(element?.props.chatId).toBe('synthetic-chat');
  expect(parseRoute('#conversation?chatId=one&chatId=two').params.chatId).toBeUndefined();
});
