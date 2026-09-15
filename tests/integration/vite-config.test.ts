import { describe, expect, it } from 'vitest';
import config from '../../vite.config';

describe('development watcher isolation', () => {
  it('does not follow runtime fixture symlinks or watch generated training dependencies', () => {
    expect(config.server?.watch).toMatchObject({
      followSymlinks: false,
      ignored: expect.arrayContaining(['**/.local/**', '**/training/.venv/**', '**/training/vendor/**']),
    });
  });

  it('keeps private runtime files blocked independently of watcher exclusions', () => {
    expect(config.server?.fs).toMatchObject({
      strict: true,
      deny: expect.arrayContaining(['.env', '.env.*', '**/.local/**', '**/*.sqlite*']),
    });
  });
});
