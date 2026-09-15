import { describe, expect, it } from 'vitest';
import { candidate, conversation } from './testing/fixtures';
import { acceptAI, assessSource, createReview, decide, evidenceStatus, selectCandidate, setKeyCondition, sourceSpans, writeStatement } from './model';

describe('H01 candidate disposition', () => {
  it('starts with no preselected disposition', () => {
    const review = createReview(conversation, [candidate()]);
    expect(review.ok).toBe(true);
    if (review.ok) expect(review.data.items[0]?.disposition).toBe(null);
  });
  it('allows all four choices and explicit cancellation without formal data', () => {
    const review = createReview(conversation, [candidate()]);
    if (!review.ok) throw Error('fixture');
    for (const disposition of ['handoff', 'archive', 'reject', 'later', null] as const) {
      const next = decide(review.data, 'candidate-1', disposition);
      expect(next.ok).toBe(true);
      if (next.ok) expect(next.data.items[0]?.disposition).toBe(disposition);
    }
    expect(review.data.items[0]?.disposition).toBe(null);
  });
  it('rejects foreign or duplicate candidates and unknown IDs', () => {
    expect(createReview(conversation, [{ ...candidate(), conversationId: 'foreign' }]).ok).toBe(false);
    expect(createReview(conversation, [candidate(), candidate()]).ok).toBe(false);
    const review = createReview(conversation, [candidate()]);
    if (review.ok) expect(decide(review.data, 'missing', 'handoff').ok).toBe(false);
  });
  it('rejects ambiguous source segment or source record IDs', () => {
    expect(createReview({ ...conversation, segments: [...conversation.segments, conversation.segments[0]!] }, [candidate()]).ok).toBe(false);
    const duplicated = candidate(); duplicated.sources.push(duplicated.sources[0]!);
    expect(createReview(conversation, [duplicated]).ok).toBe(false);
  });
});

describe('H05 source support is independent of confirmation', () => {
  function item() { const result = createReview(conversation, [candidate()]); if (!result.ok) throw Error('fixture'); return writeStatement(result.data.items[0]!, '我的主张'); }
  it('starts unverified even if a model asserted support', () => {
    const proposed = candidate(); proposed.sources[0]!.support = 'supports';
    const result = createReview(conversation, [proposed]);
    if (!result.ok) throw Error('fixture');
    expect(evidenceStatus(result.data.items[0]!.sources)).toBe('unverified');
  });
  it('records assessment without changing source quotation', () => {
    const result = assessSource(item(), 'source-1', 'supports', '');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.sources[0]?.excerpt).toBe(candidate().sources[0]!.excerpt);
      expect(evidenceStatus(result.data.sources)).toBe('supported');
      expect(evidenceStatus(writeStatement(result.data, '已变更的主张').sources)).toBe('unverified');
    }
  });
  it('never treats a URL alone as supporting evidence', () => {
    const reviewItem = item(); reviewItem.sources[0]!.excerpt = '';
    reviewItem.sources[0]!.url = 'https://example.org';
    expect(assessSource(reviewItem, 'source-1', 'supports', '').ok).toBe(false);
    expect(assessSource(item(), 'missing', 'supports', '').ok).toBe(false);
  });
  it('retains disputed and partial assessments and allows undo to unverified', () => {
    expect(assessSource(item(), 'source-1', 'partial', '').ok).toBe(false);
    const partial = assessSource(item(), 'source-1', 'partial', '只支持部分范围');
    if (!partial.ok) throw Error('fixture');
    expect(evidenceStatus(partial.data.sources)).toBe('partial');
    const rejected = assessSource(item(), 'source-1', 'does_not_support', '与主张相反');
    if (!rejected.ok) throw Error('fixture');
    expect(evidenceStatus(rejected.data.sources)).toBe('disputed');
    const reset = assessSource(rejected.data, 'source-1', 'unverified', '');
    if (reset.ok) expect(evidenceStatus(reset.data.sources)).toBe('unverified');
  });
});

describe('H04 one key condition', () => {
  function item() { const result = createReview(conversation, [candidate()]); if (!result.ok) throw Error('fixture'); return result.data.items[0]!; }
  it('keeps the unresolved condition explicitly unknown', () => {
    expect(item().conditions).toHaveLength(1);
    expect(item().conditions[0]?.status).toBe('unknown');
  });
  it('allows a concrete judgment without asking for all fields', () => {
    const result = setKeyCondition(item(), '仅在已确认前提时适用', 'confirmed');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.conditions[0]?.text).toBe('仅在已确认前提时适用');
  });
  it('rejects empty confirmation and permits returning to unknown', () => {
    expect(setKeyCondition(item(), ' ', 'confirmed').ok).toBe(false);
    const result = setKeyCondition(item(), '', 'unknown');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.conditions[0]?.confirmedBy).toBeUndefined();
  });
});

describe('H03 human expression and attribution', () => {
  function review() { const result = createReview(conversation, [candidate(), candidate('candidate-2')]); if (!result.ok) throw Error('fixture'); return result.data; }
  it('does not prefill the human statement with an AI claim', () => {
    expect(review().items[0]?.statement).toBe('');
  });
  it('distinguishes written, accepted, edited and exact copied text', () => {
    let item = review().items[0]!;
    expect(writeStatement(item, '我的限定陈述').authorship).toBe('human_written');
    item = acceptAI(item);
    expect(item.authorship).toBe('ai_accepted');
    expect(writeStatement(item, '修改后的陈述').authorship).toBe('human_edited');
    expect(writeStatement(review().items[0]!, candidate().claim).authorship).toBe('ai_accepted');
  });
  it('retains text through cancel and candidate switching without sharing it', () => {
    const state = review();
    state.items[0] = writeStatement(state.items[0]!, '只属于第一条');
    const cancelled = decide(state, 'candidate-1', null);
    if (!cancelled.ok) throw Error('fixture');
    expect(cancelled.data.items[0]?.statement).toBe('只属于第一条');
    expect(cancelled.data.items[1]?.statement).toBe('');
  });
});

describe('H02 one-at-a-time review', () => {
  it('retains each item independently when switching', () => {
    const created = createReview(conversation, [candidate(), candidate('candidate-2')]);
    if (!created.ok) throw Error('fixture');
    const chosen = decide(created.data, 'candidate-1', 'reject');
    if (!chosen.ok) throw Error('fixture');
    const second = selectCandidate(chosen.data, 'candidate-2');
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.data.activeId).toBe('candidate-2');
      expect(second.data.items.map((item) => item.disposition)).toEqual(['reject', null]);
    }
    expect(selectCandidate(created.data, 'foreign').ok).toBe(false);
  });
  it('locates source text using UTF-16 offsets and rejects modified quotes', () => {
    expect(sourceSpans(conversation, candidate()).ok).toBe(true);
    const changed = candidate();
    changed.spans[0]!.quote = '伪造原句';
    expect(sourceSpans(conversation, changed).ok).toBe(false);
  });
  it('rejects more than three candidates without silent truncation', () => {
    expect(createReview(conversation, [1, 2, 3, 4].map((id) => candidate(String(id)))).ok).toBe(false);
  });
});
