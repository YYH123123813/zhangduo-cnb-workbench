import { describe, expect, it } from 'vitest';
import { privateDevPath } from '../../tools/client-boundary';

describe('W03 private local files stay outside the development web server', () => {
  it.each(['/.local/operations.sqlite', '/%2elocal/db.sqlite-wal?raw', '/@fs/project/.local/state', '/.env', '/.env.local', '/.git/config', '/src/platform/journal.ts', '/%zz'])('blocks %s', (path) => {
    expect(privateDevPath(path)).toBe(true);
  });
  it.each(['/src/app/App.tsx', '/src/features/handoff/client.tsx', '/api/workspace', '/@vite/client'])('allows %s', (path) => {
    expect(privateDevPath(path)).toBe(false);
  });
});
