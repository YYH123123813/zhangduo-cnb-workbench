import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { conversation } from './fixtures.test-support';

vi.mock('./model-flow', () => {
  class FakeCaptureModelFlow {
    getSnapshot = () => ({
      phase: 'unknown', stage: 'unknown', discovery: 'ready', discovered: [], registration: 'unknown',
      registrationIdentity: null,
      approval: { id: 'actual-model-approval', actorId: conversation.workspaceId.replace('workspace', 'actor'), workspaceId: conversation.workspaceId, contentHash: 'input-hash', baseRevision: conversation.contentHash, objectIds: ['segment-1'] },
      recoveryId: 'original-model-operation', sent: true, delivery: null, operation: null, extraction: null, message: '',
    });
    subscribe = () => () => undefined;
    getLeaveState = () => 'blocked' as const;
    activate() {}
    dispose() {}
    send() {}
    continueOriginal() {}
    cancel() {}
    readApprovalRegistration() {}
    discover() {}
    restoreDiscovered() {}
    readBack() {}
    restore() {}
  }
  return { CaptureModelFlow: FakeCaptureModelFlow };
});

import { ModelPanel } from './model-panel';

describe('C12 model recovery identity labels', () => {
  it('shows the original operation ID separately from the actual model approval ID', () => {
    const html = renderToStaticMarkup(createElement(ModelPanel, {
      conversation,
      status: null,
      storedDelivery: null,
      onDelivery: () => undefined,
      onUnknown: () => undefined,
      onLock: () => undefined,
    }));

    expect(html).toContain('实际模型批准ID');
    expect(html).toContain('原模型操作ID');
    expect(html).toContain('actual-model-approval');
    expect(html).toContain('original-model-operation');
    expect(html).not.toContain('原模型批准ID');
  });
});
