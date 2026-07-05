import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { WriteResult } from './types';

export function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * Re-serialize `obj` to JSON while preserving the ORIGINAL text's formatting —
 * its indentation (tabs vs N spaces) and whether it ended with a newline, and
 * whether it was compact (single-line) at all. This is the one source of truth
 * (Rule 2) for every additive JSON edit dxkit makes to a file the user owns
 * (`package.json` devDep / postinstall on install; the inverse on uninstall).
 *
 * Why it matters: a naive `JSON.stringify(obj, null, 2)` REFORMATS the whole
 * file, so adding one devDependency rewrites a compact or tab-indented
 * `package.json` into 2-space-pretty — a change dxkit can never cleanly undo,
 * because the original style is already lost by uninstall time. Preserving the
 * style keeps the "exact pre-dxkit state" promise for surgical edits.
 */
export function serializePreservingJson(original: string, obj: unknown): string {
  const trailing = original.endsWith('\n') ? '\n' : '';
  // Compact: no internal newline in the trimmed source → keep it single-line.
  if (original.trim().length > 0 && !original.trim().includes('\n')) {
    return JSON.stringify(obj) + trailing;
  }
  const m = original.match(/\n([ \t]+)"/);
  const indent = m ? (m[1][0] === '\t' ? '\t' : m[1].length) : 2;
  return JSON.stringify(obj, null, indent) + trailing;
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
