import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseRoute } from '../../app/routing';
import { captureHref, handoffHref, manualHandoffHref } from './links';
import { CaptureRecord } from './record';
import { conversation } from './fixtures.test-support';

describe('C12 shared 1.12 manual handoff and operation navigation', () => {
  it('distinguishes manual source from an explicit candidate without sending content', () => {
    expect(parseRoute(manualHandoffHref('source-id'))).toEqual({ page: 'handoff', params: { conversationId: 'source-id', source: 'manual' } });
    expect(parseRoute(handoffHref('source-id', 'candidate-id'))).toEqual({ page: 'handoff', params: { conversationId: 'source-id', candidateId: 'candidate-id', source: 'candidate' } });
  });
  it('encodes a recovery link carrying exactly the original conversation and approval IDs', () => {
    expect(parseRoute(captureHref('source&x=1', 'approval#original'))).toEqual({ page: 'capture', params: { conversationId: 'source&x=1', approvalId: 'approval#original' } });
    expect(parseRoute(captureHref('source-id'))).toEqual({ page: 'capture', params: { conversationId: 'source-id' } });
  });
  it('rejects unknown handoff modes and duplicate identity parameters through the shared parser', () => {
    expect(parseRoute('#handoff?conversationId=c&source=automatic').page).toBe('invalid');
    expect(parseRoute('#capture?conversationId=c&approvalId=a&approvalId=b').page).toBe('invalid');
  });
  it('keeps the explicit manual link in the saved-source view with AI unavailable', () => {
    const html = renderToStaticMarkup(createElement(CaptureRecord, { conversation, status: null }));
    expect(html).toContain('手动整理'); expect(html).toContain(`conversationId=${conversation.id}&amp;source=manual`);
    expect(html).not.toContain('candidateId=');
  });
});
