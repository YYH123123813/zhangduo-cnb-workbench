import { describe, expect, it, vi } from 'vitest';
import { RequestGate } from './request-gate';

describe('H10 synchronous request ownership', () => {
  it('rejects a second command before React has rendered its disabled button', () => {
    const gate = new RequestGate();
    const first = gate.begin();
    expect(first).not.toBeNull();
    expect(gate.begin()).toBeNull();
    expect(gate.pending).toBe(true);
    expect(gate.finish(first!)).toBe(true);
    expect(gate.begin()).not.toBeNull();
  });
  it('does not let an abandoned response replace state or unlock a newer request', async () => {
    const gate = new RequestGate(); const install = vi.fn();
    const first = gate.begin()!;
    let resolve!: () => void;
    const response = new Promise<void>((done) => { resolve = done; });
    const oldRequest = response.then(() => { if (gate.isCurrent(first)) install(); return gate.finish(first); });
    gate.invalidate();
    const second = gate.begin()!;
    resolve();
    expect(await oldRequest).toBe(false);
    expect(install).not.toHaveBeenCalled();
    expect(gate.isCurrent(second)).toBe(true);
    expect(gate.pending).toBe(true);
  });
  it('lets the latest target read replace an older read without installing its delayed response', async () => {
    const gate = new RequestGate(); const install = vi.fn();
    const first = gate.beginReplacingRead()!;
    let resolve!: () => void;
    const oldRead = new Promise<void>((done) => { resolve = done; }).then(() => {
      if (gate.isCurrent(first)) install('old-conversation');
      return gate.finish(first);
    });
    const latest = gate.beginReplacingRead()!;
    expect(latest).not.toBe(first);
    resolve(); expect(await oldRead).toBe(false);
    expect(install).not.toHaveBeenCalled(); expect(gate.isCurrent(latest)).toBe(true);
    expect(gate.finish(latest)).toBe(true);
  });
  it('never supersedes a write or a nonreplaceable read when target parameters change', () => {
    const gate = new RequestGate(); const write = gate.begin()!;
    expect(gate.beginReplacingRead()).toBeNull();
    expect(gate.cancelReplacingRead()).toBe(false);
    expect(gate.isCurrent(write)).toBe(true); expect(gate.pending).toBe(true);
    expect(gate.finish(write)).toBe(true);
    const read = gate.beginReplacingRead()!;
    expect(gate.begin()).toBeNull();
    expect(gate.finish(read)).toBe(true);
    expect(gate.begin()).not.toBeNull();
  });
  it('detaches the old target read even when a changed target cannot replace unsaved review contents', () => {
    const gate = new RequestGate(); const old = gate.beginReplacingRead()!;
    expect(gate.cancelReplacingRead()).toBe(true);
    expect(gate.isCurrent(old)).toBe(false); expect(gate.finish(old)).toBe(false);
    expect(gate.pending).toBe(false); expect(gate.cancelReplacingRead()).toBe(false);
    const write = gate.begin()!;
    expect(gate.cancelReplacingRead()).toBe(false); expect(gate.isCurrent(write)).toBe(true);
  });
});
