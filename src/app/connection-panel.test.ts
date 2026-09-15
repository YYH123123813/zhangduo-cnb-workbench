import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ConnectionForm } from './connection-panel';

describe('W02 accessible connection form (static only)', () => {
  it('requires an explicit confirmation and local key, with no client identity or CNB token fields', () => {
    const html = renderToStaticMarkup(createElement(ConnectionForm, { ready: true, busy: false, onSubmit: vi.fn() }));
    expect(html).toContain('type="password"'); expect(html.toLowerCase()).toContain('autocomplete="off"');
    expect(html).toContain('type="checkbox"'); expect(html).not.toContain('checked=""');
    expect(html).toContain('type="submit" disabled=""');
    expect(html).not.toContain('name="actorId"'); expect(html).not.toContain('name="CNB_TOKEN"');
  });
  it('keeps unconfigured and in-flight connection forms closed', () => {
    for (const props of [{ ready: false, busy: false }, { ready: true, busy: true }]) {
      const html = renderToStaticMarkup(createElement(ConnectionForm, { ...props, onSubmit: vi.fn() }));
      expect(html).toContain('disabled=""');
    }
  });
});
