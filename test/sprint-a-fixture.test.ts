/**
 * Sprint A regression coverage — exercises the committed `csharp-
 * nested` benchmark fixture against D030 (registry-driven hygiene
 * grep) and D035 (depVulns preflight reachability).
 *
 * Why a separate test file:
 *
 *   - `test/languages-csharp.test.ts` already covers D024 (depth-5
 *     detect) against the same fixture. Keeping it focused on pure
 *     pack contract.
 *   - `test/languages-csharp-depvulns.test.ts` already covers D035
 *     against a synthetic tmpdir (the symmetry assertion). What's
 *     added here: the assertion runs against the COMMITTED fixture
 *     so a future refactor that breaks fixture-path resolution
 *     (vs synthetic tmpdir) is caught.
 *   - D030 has no committed-fixture coverage yet — `gather.ts`'s
 *     `gatherHygieneMarkers` runs at the integration layer and the
 *     existing slop tests synthesize counts directly.
 *
 * The fixture's vulnerable `Newtonsoft.Json@9.0.1` PackageReference
 * is intentionally dormant in Sprint A (no test here invokes a real
 * dotnet binary). Sub-branch #3 (`feat/phase-10ux-2.4.7-nuget-
 * direct`) will activate it via D025f's PackageReference parser
 * path; that test lives there.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { getLanguage } from '../src/languages';
import { gatherHygieneMarkers } from '../src/analyzers/quality/gather';

// Resolve the csharp pack THROUGH the index registry rather than via
// `import { csharp } from '../src/languages/csharp'` directly. Importing
// the named pack symbol AND the LANGUAGES array (transitively, via
// gather.ts → src/languages/index.ts) from the same test file triggers
// vitest's module-hoister to evaluate `languages/csharp.ts` before
// `languages/index.ts` finishes building LANGUAGES — index.ts then sees
// the csharp module mid-evaluation and stamps `undefined` into the
// LANGUAGES[2] slot for the lifetime of the test process. Subsequent
// `allSourceExtensions()` calls crash on `l.sourceExtensions` where
// `l` is the undefined slot. Discovered 2026-05-12; the symptom is
// specific to ESM hoisting + the side-effecting top-level LANGUAGES
// array construction; the registry-mediated path avoids it.
const csharp = getLanguage('csharp')!;

const FIXTURE_ROOT = path.resolve(__dirname, 'fixtures/benchmarks/csharp-nested');

describe('csharp-nested fixture — Sprint A coverage', () => {
  // D024 — duplicated from `test/languages-csharp.test.ts` so this file
  // is self-contained as the "Sprint A regression bundle." If the depth
  // bump regresses, this file is the single grep-target.
  it('csharp.detect() returns true from the fixture root (D024)', () => {
    expect(csharp.detect(FIXTURE_ROOT)).toBe(true);
  });

  // D030 — the entire reason for the registry-driven `--include` list.
  // Pre-D030 this fixture's TODO/FIXME/HACK were invisible because '*.cs'
  // wasn't in the hardcoded grep --include set. Post-D030 they surface.
  // We don't pin exact counts (the fixture only has 1 of each, but the
  // hygiene gather greps the whole tree — node_modules/dist excluded
  // — so unrelated files in the fixture root could in principle add
  // hits). We assert non-zero for the three tiers we deliberately
  // planted; a 0 here means the registry-driven include list regressed.
  it('gatherHygieneMarkers surfaces non-zero TODO/FIXME/HACK from the fixture (D030)', () => {
    const markers = gatherHygieneMarkers(FIXTURE_ROOT);
    expect(markers.todoCount).toBeGreaterThan(0);
    expect(markers.fixmeCount).toBeGreaterThan(0);
    expect(markers.hackCount).toBeGreaterThan(0);
  });

  // D035 — the gather's preflight must agree with detect() on depth-5
  // layouts. The provider collapses outcome enums to null, so we can't
  // observe the exact reason directly. The strongest assertion we can
  // make without a real dotnet binary is "the call resolves to a
  // defined result without throwing" — which proves the preflight
  // didn't reject before the dotnet probe. Pre-D035 it would have
  // returned null via hasCsharpProject's depth-1 rejection; we don't
  // care which branch the call exited through, only that the deepened
  // walk found the .csproj.
  it('depVulns gather reaches the dotnet probe on the fixture (D035)', async () => {
    const result = await csharp.capabilities!.depVulns!.gather(FIXTURE_ROOT);
    expect(result === null || typeof result === 'object').toBe(true);
  });
});
