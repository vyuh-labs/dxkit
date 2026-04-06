import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { WriteResult } from './types';

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

export async function writeFile(
  outputPath: string,
  content: string,
  opts: { force: boolean; evolving: boolean; skipIfExists: boolean },
): Promise<WriteResult> {
  const exists = fs.existsSync(outputPath);

  if (exists) {
    if (opts.evolving) return 'skipped';
    if (opts.skipIfExists && !opts.force) return 'skipped';
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf-8');
  return exists ? 'overwritten' : 'created';
}

export function copyFile(
  src: string,
  dest: string,
  opts: { force: boolean; evolving: boolean; skipIfExists: boolean },
): WriteResult {
  const exists = fs.existsSync(dest);

  if (exists) {
    if (opts.evolving) return 'skipped';
    if (opts.skipIfExists && !opts.force) return 'skipped';
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return exists ? 'overwritten' : 'created';
}

export function makeExecutable(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    fs.chmodSync(filePath, stat.mode | 0o111);
  } catch {
    /* ignore on Windows */
  }
}

export function copyDirectory(src: string, dest: string, opts: { force: boolean }): number {
  let count = 0;
  if (!fs.existsSync(src)) return count;

  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      count += copyDirectory(srcPath, destPath, opts);
    } else {
      const exists = fs.existsSync(destPath);
      if (exists && !opts.force) continue;
      fs.copyFileSync(srcPath, destPath);
      count++;
    }
  }
  return count;
}
