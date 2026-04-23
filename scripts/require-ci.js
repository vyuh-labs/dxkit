#!/usr/bin/env node
/**
 * prepublishOnly guard — refuses to publish outside GitHub Actions.
 *
 * Why: local `npm publish` bypasses the release pipeline's PR review,
 * tag-on-main check, CI-green gate, version-not-on-npm preflight, and
 * provenance attestation. The v2.2.0 release shipped from a local
 * publish; CI's own publish attempt then 403'd because the version was
 * already taken (D015 in the internal defect log).
 *
 * This hook makes accidental local publish impossible — it fails before
 * the registry is ever contacted. Belt-and-suspenders with
 * `publishConfig.provenance: true`, which additionally requires an OIDC
 * token that only exists inside GitHub Actions.
 *
 * Every console.* here is the entire user-facing surface of this
 * guard, so slop-ok is the correct annotation.
 */

const { CI, GITHUB_ACTIONS } = process.env;

if (CI !== 'true' || GITHUB_ACTIONS !== 'true') {
  console.error(''); // slop-ok
  console.error('  ✗ npm publish is only allowed from GitHub Actions.'); // slop-ok
  console.error(''); // slop-ok
  console.error('  Release procedure (see CLAUDE.md §"Release procedure"):'); // slop-ok
  console.error('    1. Open a PR against main. CI must pass.'); // slop-ok
  console.error('    2. Merge via the GitHub UI.'); // slop-ok
  console.error('    3. After main is green, tag: git tag -a vX.Y.Z && git push origin vX.Y.Z'); // slop-ok
  console.error('    4. Creating a GitHub Release from the tag triggers the publish workflow.'); // slop-ok
  console.error(''); // slop-ok
  console.error('  Local `npm publish` was blocked to preserve tag-ancestor, CI-green,'); // slop-ok
  console.error('  version-not-on-npm, and provenance guarantees that only CI can enforce.'); // slop-ok
  console.error(''); // slop-ok
  process.exit(1);
}

console.log('✓ CI guard: running inside GitHub Actions, publish may proceed'); // slop-ok
