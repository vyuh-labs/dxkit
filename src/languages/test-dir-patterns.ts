/**
 * Cross-ecosystem test-DIRECTORY conventions — the one definition, in a LEAF
 * module so both the registry (`index.ts`, which unions them into
 * `allTestFilePatterns`) and an individual pack can import it without a module
 * cycle. A pack needs it when calling `walkSourceFiles` with explicit
 * `testFilePatterns` (the pack path may never trigger the walker's
 * registry-union default — see the module-cycle note in walk-source-files.ts).
 *
 * Path-anchored (each contains `/`), so `splitTestFilePatterns` routes them
 * to the path matcher: `__tests__/**` matches `src/__tests__/a.ts` AND
 * `a/b/__tests__/c.ts` (anywhere in the tree). The walker only evaluates
 * these against files that already passed the source-extension filter, so
 * non-source files under a test dir are never misclassified.
 *
 * `__mocks__/` is intentionally excluded — mocks are test *support*, not
 * tests, and counting them would inflate the test-file ratio.
 */
export const UNIVERSAL_TEST_DIR_PATTERNS: readonly string[] = [
  '__tests__/**',
  'test/**',
  'tests/**',
  'spec/**',
  'e2e/**',
];
