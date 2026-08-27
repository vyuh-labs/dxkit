/**
 * Ledger renderers for the tree verification's install and floor-skip
 * outcomes (`verify-tree.ts`), split out for module size. Every surface
 * that prints an install outcome (the remediate ledger, the install-failed
 * note) reads these, so the attribution evidence (what the base did) is
 * phrased once.
 */
import type { BaseInstallProbe, FloorSkip, InstallOutcome, InstallStep } from './verify-tree';

/** One-line disclosure of the install step for a ledger. */
export function describeInstall(install: InstallOutcome | undefined): string | null {
  if (!install) return null;
  switch (install.status) {
    case 'no-provision-declared':
      return (
        'Install: no active pack declares an install for this tree ' +
        `(${install.packs.length > 0 ? install.packs.join(', ') : 'no pack detected'}); ` +
        'the floor ran on the tree as checked out, unprovisioned.'
      );
    case 'installed':
      return `Install: ${describeSteps(install.steps)}.`;
    case 'failed': {
      const cmd = `\`${install.argv.join(' ')}\``;
      const remedy = install.unauthorizedRemedy ? ` ${install.unauthorizedRemedy}.` : '';
      // The FINAL failing class leads; when a fallback ran and failed with a
      // different class than the primary, both are disclosed.
      const classes =
        install.primaryClassification !== undefined
          ? `${install.classification}; the primary failed as ${install.primaryClassification}`
          : install.classification;
      if (install.attribution === 'pre-existing') {
        return (
          `Install: ${cmd} fails on a clean checkout of the BASE too (${install.classification} ` +
          'on both sides): pre-existing (not caused by this change), disclosed. CI installs will ' +
          'keep failing until the dependency tree is repaired on the default branch.' +
          remedy
        );
      }
      if (install.attribution === 'undetermined') {
        return (
          `Install: ${cmd} fails on a clean checkout, and the BASE's install fails too, but ` +
          'neither failure has a shape the pack classifiers recognize, so dxkit cannot verify ' +
          'they are the same break: UNDETERMINED, disclosed (never asserted pre-existing, ' +
          'never blamed on the change). Verification proceeds without the floor; repair the ' +
          "default branch's install to restore attribution." +
          remedy
        );
      }
      const evidence = describeBaseProbe(install.base);
      return (
        `Install: ${cmd} FAILED on a clean checkout (${classes}; CI cannot ` +
        `install this tree).${evidence ? ` ${evidence}.` : ''}${remedy}`
      );
    }
  }
}

function describeSteps(steps: readonly InstallStep[]): string {
  return steps
    .map((s) =>
      s.fallback
        ? `\`${s.argv.join(' ')}\` failed, \`${s.fallback.argv.join(' ')}\` succeeded ` +
          `(${s.fallback.when}: ${s.fallback.reason})`
        : `\`${s.argv.join(' ')}\` succeeded on a clean checkout`,
    )
    .join('; ');
}

/** The base probe's evidence for a NET-NEW attribution. */
function describeBaseProbe(base: BaseInstallProbe | undefined): string | null {
  if (!base) return null;
  switch (base.status) {
    case 'installed':
      return `The base installs: ${describeSteps(base.steps)}, so the break is this change's`;
    case 'failed':
      return (
        `The base fails DIFFERENTLY (\`${base.argv.join(' ')}\`: ${base.classification}), ` +
        'so this failure is still attributed to the change'
      );
    case 'no-provision-declared':
      return 'The base declares no install at all, so this failure is attributed to the change';
  }
}

/** One-line disclosure of a skipped floor for a ledger. */
export function describeFloorSkip(skip: FloorSkip | undefined): string | null {
  if (!skip) return null;
  return `Correctness floor: **not run** (${skip.reason}): ${skip.detail}.`;
}
