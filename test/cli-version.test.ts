import { describe, expect, it, vi } from 'vitest';
import { formatVersionInfo, run } from '../src/cli';

describe('version subcommand', () => {
  it('formats dxkit, Node, and platform details on separate lines', () => {
    expect(
      formatVersionInfo({
        dxkitVersion: '2.6.0-test',
        nodeVersion: 'v22.1.0',
        platform: 'linux',
        arch: 'x64',
      }),
    ).toBe('vyuh-dxkit 2.6.0-test\nnode v22.1.0\nlinux x64');
  });

  it('prints version diagnostics from the CLI route', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await run(['node', 'vyuh-dxkit', 'version']);

      const output = log.mock.calls.map(([message]) => String(message)).join('\n');
      expect(output).toContain('vyuh-dxkit ');
      expect(output).toContain(`node ${process.version}`);
      expect(output).toContain(`${process.platform} ${process.arch}`);
    } finally {
      log.mockRestore();
    }
  });

  it('lists the version subcommand in help output', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await run(['node', 'vyuh-dxkit', '--help']);

      const output = log.mock.calls.map(([message]) => String(message)).join('\n');
      expect(output).toContain('vyuh-dxkit version');
    } finally {
      log.mockRestore();
    }
  });
});
