/**
 * dxkit's RUNTIME-OUTPUT paths — regenerable analyzer state that must never
 * ride a delivery commit. ONE list (Rule 2), in a leaf module (no imports)
 * so every consumer can reach it without a cycle:
 *
 *   - `installIgnoreFiles` (ship-installers): the `.gitignore` block init
 *     seeds;
 *   - the remediate runner's leftover sweep + runtime-artifact scrub
 *     (`remediate/git-ops.ts`): a repo onboarded WITHOUT the ignore block
 *     (or whose agent committed scan output it generated mid-run) otherwise
 *     ships `.dxkit/reports/*` inside a remediation PR — observed live on a
 *     salvage draft.
 *
 * Directory entries end with `/`; file entries are exact paths.
 */
export const DXKIT_RUNTIME_ARTIFACT_PATHS: readonly string[] = [
  '.dxkit/reports/',
  '.dxkit/dashboard.html',
  '.dxkit/cache/',
  '.dxkit/loop/',
  'graphify-out/',
];

/** Is a repo-relative POSIX path one of dxkit's runtime artifacts? */
export function isRuntimeArtifactPath(rel: string): boolean {
  return DXKIT_RUNTIME_ARTIFACT_PATHS.some((p) =>
    p.endsWith('/') ? rel.startsWith(p) : rel === p,
  );
}
