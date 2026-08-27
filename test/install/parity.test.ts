import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getLanguage, installStrategyProviders, LANGUAGES } from '../../src/languages';
import {
  ciInstallVariants,
  renderInstallDependenciesShell,
  renderInstallLine,
} from '../../src/install/shell';
import { runInstall } from '../../src/install/run';
import { defaultResolvedTolerances, type ResolvedTolerances } from '../../src/install/tolerances';
import { runDeclaredInstall } from '../../src/lanes/verify-tree';
import { runCorrectnessFloor } from '../../src/analyzers/correctness/run';
import { LOCKFILE_SYNC_LABEL } from '../../src/languages/capabilities/correctness';
import {
  installCommandText,
  type InstallStrategy,
  type InstallVariant,
} from '../../src/languages/capabilities/install-strategy';
import { NODE_STRATEGY_BY_PM } from '../../src/languages/node-install';

/**
 * The PARITY net (Rule 2.30, the semantic-divergence variant): the CI
 * template's rendered install chain, the executor the tree verification
 * runs, and the floor's lockfile-sync tolerance are THREE CONSUMERS of one
 * concept holding different shapes (a shell line, an argv ladder, a
 * tolerated-failure predicate). This is the net that should have existed
 * when the lane verified a tree with a blanket fallback the ledger then
 * misnamed. For every variant of every pack, and for every declared
 * tolerance class, the command sequence the template renders == what the
 * verification executes == what the floor's check tolerates.
 */

const TS = getLanguage('typescript')!;
const PROVIDERS = installStrategyProviders(LANGUAGES).map((p) => p.provider);
const DEFAULTS = defaultResolvedTolerances();
const NONE: ResolvedTolerances = { tolerated: new Set(), sources: new Map(), unknown: [] };

const text = installCommandText;

/** The shell projection of a plan under `t`: what `a || b` would execute
 *  when `a` fails (the shell cannot classify, so `b` is unconditional). */
function shellSequence(v: InstallVariant, t: ResolvedTolerances): string[] {
  return renderInstallLine(v, t).replace(' 2>/dev/null', '').split(' || ');
}

/** What the executor runs when the primary fails with `output`. */
function executorSequence(s: InstallStrategy, output: string, t: ResolvedTolerances): string[] {
  const argvs: string[] = [];
  runInstall(
    s.modes.frozen,
    '/repo',
    (cmd) => {
      argvs.push(text(cmd));
      return { available: true, code: 1, output };
    },
    t,
  );
  return argvs;
}

/** A tmp repo carrying the files a variant keys on. */
function repoFor(v: InstallVariant): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-parity-'));
  writeFileSync(join(dir, 'package.json'), '{"name":"x"}');
  for (const f of v.when) writeFileSync(join(dir, f), '');
  return dir;
}

describe('template == executor == verifier, per variant', () => {
  const variants = ciInstallVariants(PROVIDERS);

  it('the CI chain enumerates exactly the node variants, in selection order', () => {
    expect(variants.map((v) => v.when.join('|'))).toEqual(
      TS.installStrategy!.variants().map((v) => v.when.join('|')),
    );
    const shell = renderInstallDependenciesShell('', PROVIDERS, DEFAULTS);
    for (const v of variants) {
      for (const f of v.when) expect(shell).toContain(`[ -f ${f} ]`);
      expect(shell.split('\n').map((l) => l.trim())).toContain(renderInstallLine(v, DEFAULTS));
    }
  });

  for (const v of variants) {
    const label = v.when.join('+');
    const s = v.strategy;

    it(`${label}: the primary the template renders is the primary the verification runs`, () => {
      const dir = repoFor(v);
      try {
        const argvs: string[] = [];
        const r = runDeclaredInstall(
          dir,
          (cmd) => {
            argvs.push(text(cmd));
            return { available: true, code: 0, output: '' };
          },
          [TS],
          DEFAULTS,
        );
        expect(r.status).toBe('installed');
        expect(argvs).toEqual([shellSequence(v, DEFAULTS)[0]]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    for (const fb of s.modes.frozen.fallbacks) {
      // A failure with the fallback's shape: the shell chain and the
      // executor run the identical two commands, under the same
      // authorization (a withdrawn class renders no `|| b` AND runs no `b`).
      it(`${label}: the ${fb.when} fallback fires identically in the shell and the executor`, () => {
        const shape =
          fb.when === 'peer-conflict' ? 'npm ERR! code ERESOLVE' : 'error: unknown option';
        expect(fb.matches(shape)).toBe(true);
        expect(shellSequence(v, DEFAULTS)).toEqual(executorSequence(s, shape, DEFAULTS));
        expect(shellSequence(v, DEFAULTS)).toEqual([
          text(s.modes.frozen.primary),
          text(fb.command),
        ]);
        if (fb.when !== 'unsupported-flag') {
          expect(shellSequence(v, NONE)).toEqual([text(s.modes.frozen.primary)]);
          expect(executorSequence(s, shape, NONE)).toEqual([text(s.modes.frozen.primary)]);
        }
      });
    }

    if (s.syncCheck?.kind === 'command') {
      // The floor's lockfile-sync check tolerates a failure iff the frozen
      // install's fallback would answer it: one classifier, two consumers.
      it(`${label}: the floor's lockfile-sync tolerance IS the frozen fallback's classifier`, () => {
        const dir = repoFor(v);
        try {
          // The pack's lockfileCheck resolves the repo's tolerances from
          // disk (no policy here: the defaults), the same set DEFAULTS is.
          const floorOn = (output: string) =>
            runCorrectnessFloor({
              cwd: dir,
              changedFiles: [],
              scope: 'full',
              packs: [TS],
              exec: (cmd) =>
                cmd.args.includes('--dry-run')
                  ? { available: true, code: 1, output }
                  : { available: true, code: 0, output: '' },
            }).checks.find((c) => c.label === LOCKFILE_SYNC_LABEL)!;
          for (const fb of s.modes.frozen.fallbacks) {
            const shape = fb.when === 'peer-conflict' ? 'npm ERR! code ERESOLVE' : 'unknown option';
            const check = floorOn(shape);
            const executorRetried = executorSequence(s, shape, DEFAULTS).length === 2;
            expect(check.status === 'pass', `${label}: tolerated iff the executor retries`).toBe(
              executorRetried &&
                s.syncCheck!.kind === 'command' &&
                s.syncCheck!.tolerates.includes(fb.when),
            );
          }
          // And a failure NO fallback answers fails the floor exactly as the
          // executor reports it against the primary.
          const drift = 'npm ERR! code EUSAGE\nMissing: x@1 from lock file';
          expect(floorOn(drift).status).toBe('fail');
          expect(executorSequence(s, drift, DEFAULTS)).toEqual([text(s.modes.frozen.primary)]);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  it('every declared fallback of every registered pack is outcome-equivalent under a blanket shell retry (relaxes one check only)', () => {
    // The shell retries unconditionally; that is sound only while every
    // fallback is "the primary with one check relaxed" (viaFlags, or a flag
    // respelling for an older manager) and never a different command.
    for (const p of PROVIDERS) {
      for (const v of p.variants()) {
        for (const mode of Object.values(v.strategy.modes)) {
          for (const fb of mode.fallbacks) {
            const primary = mode.primary;
            expect(fb.command.bin, `${v.strategy.manager}: fallback keeps the manager`).toBe(
              primary.bin,
            );
            expect(fb.command.args[0], `${v.strategy.manager}: fallback keeps the verb`).toBe(
              primary.args[0],
            );
          }
        }
      }
    }
  });

  it('the per-PM table and the file-keyed variants are one declaration', () => {
    for (const v of TS.installStrategy!.variants()) {
      if (v.strategy.lockfile === null) continue;
      expect(NODE_STRATEGY_BY_PM[v.strategy.manager as keyof typeof NODE_STRATEGY_BY_PM]).toBe(
        v.strategy,
      );
    }
  });
});
