/**
 * Regenerate `.dxkit/reports/graph.json` by shelling out to `vyuh-dxkit health`
 * — the one place graphify is (re)run. The graph is an on-demand, gitignored
 * artifact built as a side effect of `health`; every consumer that wants a fresh
 * graph (the explore/context `--refresh` flag, `tests affected --refresh`) calls
 * this rather than duplicating the spawn + entry-point resolution.
 *
 * Output streams to the terminal so the user sees the health run's progress.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

export async function refreshGraph(cwd: string): Promise<void> {
  const dxkitBin = resolveDxkitBin();
  return new Promise<void>((resolve, reject) => {
    const child = spawn('node', [dxkitBin, 'health', cwd], { stdio: 'inherit', cwd });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vyuh-dxkit health exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function resolveDxkitBin(): string {
  // dist/explore/refresh.js → dist/index.js
  const distEntry = path.resolve(__dirname, '..', 'index.js');
  if (existsSync(distEntry)) return distEntry;
  // Fallback for local dev where __dirname might be elsewhere.
  return 'node_modules/@vyuhlabs/dxkit/dist/index.js';
}
