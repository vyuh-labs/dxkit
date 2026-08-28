/**
 * The scaffold-compile pin (4.4.7 review fix): `npm run new-lang` must emit
 * a pack that COMPILES against the real LanguageSupport contract. The class
 * this closes: a field going REQUIRED on the contract (correctness in 4.2,
 * remediation in 4.4.7) without the scaffolder learning it, so every future
 * `new-lang` emitted a pack that failed to compile and the recipe's
 * "dormant but compiling" promise silently broke.
 *
 * Mechanics: the scaffolder honors DXKIT_SCAFFOLD_ROOT (its test seam), so
 * this test runs it against a temp copy of `src/` (the scaffolder extends
 * the copied `LanguageId` union and registry in place), then typechecks the
 * emitted pack file with the repo's compiler settings. The pack's relative
 * imports resolve through the copied tree, so the check is against the real
 * types, not stubs.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const REPO = path.resolve(__dirname, '..');
// tsc's bin, resolved the way node would from the repo (a git worktree may
// share the parent checkout's hoisted node_modules, so no path is assumed).
const TSC = createRequire(path.join(REPO, 'package.json')).resolve('typescript/bin/tsc');
// The node_modules that resolution actually found, derived from tsc's own
// location; symlinked into the temp root so the copied tree's bare imports
// (the SDK bridge, jsonc-parser) typecheck exactly as they do in the repo.
const NODE_MODULES = path.resolve(TSC, '..', '..', '..');

describe('scaffold-language emits a compiling pack', () => {
  it('a scaffolded pack declares remediation and typechecks against the real contract', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-scaffold-'));
    try {
      fs.cpSync(path.join(REPO, 'src'), path.join(root, 'src'), { recursive: true });
      fs.symlinkSync(NODE_MODULES, path.join(root, 'node_modules'));
      fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n');
      execFileSync(
        process.execPath,
        [path.join(REPO, 'scripts', 'scaffold-language.js'), 'zetalang', 'Zeta Lang'],
        { env: { ...process.env, DXKIT_SCAFFOLD_ROOT: root }, stdio: 'pipe' },
      );
      const pack = path.join(root, 'src', 'languages', 'zetalang.ts');
      expect(fs.existsSync(pack)).toBe(true);
      const packSrc = fs.readFileSync(pack, 'utf8');
      // The remediation field is REQUIRED: the scaffold wires the dormant
      // (planned-exemption) declaration plus its import.
      expect(packSrc).toContain("remediation: plannedRemediationSupport('zetalang')");
      expect(packSrc).toContain(
        "import { plannedRemediationSupport } from './capabilities/remediation';",
      );
      // The scaffolder extended the copied union, so `id: 'zetalang'` types.
      const types = fs.readFileSync(path.join(root, 'src', 'types.ts'), 'utf8');
      expect(types).toMatch(/LanguageId[^;]*'zetalang'/);
      // Typecheck the emitted pack with the repo's compiler settings; the
      // relative-import closure is the copied real contract.
      execFileSync(
        process.execPath,
        [
          TSC,
          '--noEmit',
          '--strict',
          '--target',
          'ES2022',
          '--module',
          'commonjs',
          '--lib',
          'ES2022',
          '--esModuleInterop',
          '--skipLibCheck',
          '--resolveJsonModule',
          '--forceConsistentCasingInFileNames',
          pack,
        ],
        { stdio: 'pipe' },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
