/**
 * Timing helper for --verbose output.
 *
 * Wrap a gather call to print per-tool elapsed time to stderr when verbose.
 * Stdout stays clean so --json output is unaffected.
 */
export function timed<T>(name: string, verbose: boolean, fn: () => T): T {
  if (!verbose) return fn();
  const start = Date.now();
  const result = fn();
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  process.stderr.write(`  [timing] ${name.padEnd(18)} ${elapsed}s\n`);
  return result;
}

export async function timedAsync<T>(
  name: string,
  verbose: boolean,
  fn: () => Promise<T>,
): Promise<T> {
  if (!verbose) return fn();
  const start = Date.now();
  const result = await fn();
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  process.stderr.write(`  [timing] ${name.padEnd(18)} ${elapsed}s\n`);
  return result;
}
