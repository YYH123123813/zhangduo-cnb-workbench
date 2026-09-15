import { describe, expect, it } from 'vitest';
import { canStartModelExtraction, shouldAutoDiscoverModelOperations, shouldOfferDiscoveryRetry } from './model-panel-guards';

describe('model panel operation guards', () => {
  it('does not expose a new model attempt before discovery is verified', () => {
    const base = { sent: false, discovered: [] as never[], discovery: 'idle' as const };
    const delivery = { batch: { state: 'missing' as const } };

    expect(canStartModelExtraction(base, delivery)).toBe(false);
    expect(canStartModelExtraction({ ...base, discovery: 'unknown' }, delivery)).toBe(false);
    expect(canStartModelExtraction({ ...base, discovery: 'ready' }, delivery)).toBe(false);
    expect(canStartModelExtraction({ ...base, discovery: 'ready' }, delivery, true)).toBe(true);
    expect(canStartModelExtraction(base, delivery, true)).toBe(true);
    expect(canStartModelExtraction({ ...base, discovery: 'unknown' }, delivery, true)).toBe(false);
  });

  it('does not race automatic discovery with an explicit recovery link', () => {
    expect(shouldAutoDiscoverModelOperations({ recoveryApprovalId: 'original-operation', storedBatchState: 'missing', sent: false, discovery: 'idle' })).toBe(false);
    expect(shouldAutoDiscoverModelOperations({ recoveryApprovalId: undefined, storedBatchState: 'missing', sent: false, discovery: 'idle', allowInitialExtraction: true })).toBe(false);
    expect(shouldAutoDiscoverModelOperations({ recoveryApprovalId: undefined, storedBatchState: 'missing', sent: false, discovery: 'idle' })).toBe(true);
    expect(shouldAutoDiscoverModelOperations({ recoveryApprovalId: undefined, storedBatchState: 'available', sent: false, discovery: 'idle' })).toBe(false);
  });

  it('keeps an explicit read-only retry available after discovery failure', () => {
    expect(shouldOfferDiscoveryRetry({ sent: false, discovery: 'unknown' })).toBe(true);
    expect(shouldOfferDiscoveryRetry({ sent: true, discovery: 'unknown' })).toBe(false);
    expect(shouldOfferDiscoveryRetry({ sent: false, discovery: 'ready' })).toBe(false);
  });
});
