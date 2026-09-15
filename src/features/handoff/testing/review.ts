import { createReview, writeStatement } from '../model';
import { toDraft } from '../draft';
import { candidate, conversation, time } from './fixtures';
import { context } from './services';
import { snapshot } from './knowledge';
export function draftFixture() {
  const created = createReview(conversation, [candidate()]);
  if (!created.ok) throw Error('fixture');
  const review = created.data; review.actorId = context.actorId;
  const item = writeStatement({ ...review.items[0]!, disposition: 'handoff' }, '我的限定陈述');
  const result = toDraft(review, item, snapshot.revision, time);
  if (!result.ok) throw Error('fixture');
  return { draft: result.data, review };
}
