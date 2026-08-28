/**
 * The python remediation capabilities (4.4.7 V2): the import→distribution
 * mapping rail, the per-manager pin plans as pure transforms on real
 * manifest fixtures (applied / refused / adversarial), the version-probe
 * parser total over garbage, and the per-manager install command. No
 * network, no spawns — everything here is the pure half of the seam.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pythonRemediation } from '../../src/languages/python-remediation';
import { pyDistForImport } from '../../src/languages/python-dist-names';
import type {
  DeclareDependencyProvider,
  PinTransitiveProvider,
} from '../../src/languages/capabilities/remediation';

const pin = (pythonRemediation.pinTransitive as { provider: PinTransitiveProvider }).provider;
const declare = (pythonRemediation.declareDependency as { provider: DeclareDependencyProvider })
  .provider;

const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A temp root whose lockfile selects the manager under test. */
function rootWith(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-py-remediation-'));
  cleanups.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
}

function planAt(files: Record<string, string>, pkg = 'urllib3', version = '2.5.0') {
  return pin.plan({ cwd: rootWith(files), rootDir: '', pkg, version });
}

const UV_PYPROJECT = `[project]
name = "fx"
version = "0.1.0"
dependencies = [
    "requests>=2.31",
]

[tool.ruff]
line-length = 100
`;

const POETRY_PYPROJECT = `[tool.poetry]
name = "fx"
version = "0.1.0"

[tool.poetry.dependencies]
python = "^3.11"
requests = "^2.31"

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"

[build-system]
requires = ["poetry-core"]
`;

const PIPFILE = `[[source]]
url = "https://pypi.org/simple"
name = "pypi"

[packages]
requests = "*"

[dev-packages]
pytest = "*"
`;

describe('the import → distribution mapping (one table, the declare rail)', () => {
  it('identity for convention-named imports, alias for the known divergences', () => {
    expect(pyDistForImport('requests')).toBe('requests');
    expect(pyDistForImport('yaml')).toBe('pyyaml');
    expect(pyDistForImport('PIL')).toBe('pillow');
    // Spelling variants of one distribution fold under PEP 503.
    expect(pyDistForImport('sklearn')).toBe('scikit-learn');
    expect(pyDistForImport('MySQLdb')).toBe('mysqlclient');
  });

  it('refuses ambiguous aliases and injection shapes (false-negative bias)', () => {
    expect(pyDistForImport('cv2')).toBeNull(); // three real distributions
    expect(pyDistForImport('google')).toBeNull();
    expect(pyDistForImport('Crypto')).toBeNull(); // pycryptodome vs pycrypto
    for (const bad of ['', '-x', '--index-url=https://evil', 'a b', 'a\nb', './missing']) {
      expect(pyDistForImport(bad), JSON.stringify(bad)).toBeNull();
      expect(declare.validSpecifier(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('pinTransitive: the uv override surface', () => {
  it('appends [tool.uv] override-dependencies when no section exists, preserving the manifest', () => {
    const plan = planAt({ 'uv.lock': '', 'pyproject.toml': UV_PYPROJECT });
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') return;
    expect(plan.edit.file).toBe('pyproject.toml');
    const out = plan.edit.transform(UV_PYPROJECT);
    expect('text' in out).toBe(true);
    if (!('text' in out)) return;
    expect(out.text.startsWith(UV_PYPROJECT)).toBe(true);
    expect(out.text).toContain('[tool.uv]\noverride-dependencies = ["urllib3==2.5.0"]');
    expect(plan.revert).toContain('override-dependencies');
  });

  it('inserts into an existing [tool.uv] section instead of forking a second one', () => {
    const text = `${UV_PYPROJECT}\n[tool.uv]\ndev-dependencies = []\n`;
    const plan = planAt({ 'uv.lock': '', 'pyproject.toml': text });
    if (plan.kind !== 'plan') throw new Error(plan.reason);
    const out = plan.edit.transform(text);
    if (!('text' in out)) throw new Error(out.refused);
    expect(out.text.match(/\[tool\.uv\]/g)).toHaveLength(1);
    expect(out.text).toContain('[tool.uv]\noverride-dependencies = ["urllib3==2.5.0"]');
  });

  it('refuses a direct dependency, an existing override list, and garbage', () => {
    const plan = planAt({ 'uv.lock': '', 'pyproject.toml': UV_PYPROJECT }, 'requests', '2.32.0');
    if (plan.kind !== 'plan') throw new Error(plan.reason);
    const direct = plan.edit.transform(UV_PYPROJECT);
    expect(direct).toHaveProperty('refused');
    if ('refused' in direct) expect(direct.refused).toContain('dep-bump');

    const withOverride = `${UV_PYPROJECT}\n[tool.uv]\noverride-dependencies = ["x==1.0"]\n`;
    const p2 = planAt({ 'uv.lock': '', 'pyproject.toml': withOverride });
    if (p2.kind !== 'plan') throw new Error(p2.reason);
    expect(p2.edit.transform(withOverride)).toHaveProperty('refused');

    for (const garbage of ['', 'not a manifest {', '42']) {
      const out = p2.edit.transform(garbage);
      expect(out).toHaveProperty('refused');
    }
  });
});

describe('pinTransitive: the poetry + pipenv explicit-entry pins', () => {
  it('poetry: inserts the exact pin under [tool.poetry.dependencies]', () => {
    const plan = planAt({ 'poetry.lock': '', 'pyproject.toml': POETRY_PYPROJECT });
    if (plan.kind !== 'plan') throw new Error(plan.reason);
    const out = plan.edit.transform(POETRY_PYPROJECT);
    if (!('text' in out)) throw new Error(out.refused);
    expect(out.text).toContain('[tool.poetry.dependencies]\nurllib3 = "2.5.0"');
    expect(plan.revert).toContain('tool.poetry.dependencies');
  });

  it('poetry: refuses a direct dependency (main or group) and a table-less layout', () => {
    const plan = planAt({ 'poetry.lock': '', 'pyproject.toml': POETRY_PYPROJECT }, 'requests');
    if (plan.kind !== 'plan') throw new Error(plan.reason);
    expect(plan.edit.transform(POETRY_PYPROJECT)).toHaveProperty('refused');

    const dev = planAt({ 'poetry.lock': '', 'pyproject.toml': POETRY_PYPROJECT }, 'pytest');
    if (dev.kind !== 'plan') throw new Error(dev.reason);
    expect(dev.edit.transform(POETRY_PYPROJECT)).toHaveProperty('refused');

    const pep621 = '[project]\nname = "fx"\ndependencies = []\n';
    const p = planAt({ 'poetry.lock': '', 'pyproject.toml': pep621 });
    if (p.kind !== 'plan') throw new Error(p.reason);
    const out = p.edit.transform(pep621);
    expect(out).toHaveProperty('refused');
    if ('refused' in out) expect(out.refused).toContain('[tool.poetry.dependencies]');
  });

  it('pipenv: inserts the ==pin under [packages], refuses direct entries either section', () => {
    const plan = planAt({ 'Pipfile.lock': '', Pipfile: PIPFILE });
    if (plan.kind !== 'plan') throw new Error(plan.reason);
    expect(plan.edit.file).toBe('Pipfile');
    const out = plan.edit.transform(PIPFILE);
    if (!('text' in out)) throw new Error(out.refused);
    expect(out.text).toContain('[packages]\nurllib3 = "==2.5.0"');

    const direct = planAt({ 'Pipfile.lock': '', Pipfile: PIPFILE }, 'requests');
    if (direct.kind !== 'plan') throw new Error(direct.reason);
    expect(direct.edit.transform(PIPFILE)).toHaveProperty('refused');
    const dev = planAt({ 'Pipfile.lock': '', Pipfile: PIPFILE }, 'pytest');
    if (dev.kind !== 'plan') throw new Error(dev.reason);
    expect(dev.edit.transform(PIPFILE)).toHaveProperty('refused');
  });

  it('refuses a requirements-only root, an empty root, and injection-shaped tokens', () => {
    const reqs = planAt({ 'requirements.txt': 'requests==2.31.0\n' });
    expect(reqs.kind).toBe('refused');
    if (reqs.kind === 'refused') expect(reqs.reason).toContain('agent tier');

    expect(planAt({}).kind).toBe('refused');

    const badPkg = planAt({ 'uv.lock': '', 'pyproject.toml': UV_PYPROJECT }, '-x', '1.0.0');
    expect(badPkg.kind).toBe('refused');
    const badVersion = planAt(
      { 'uv.lock': '', 'pyproject.toml': UV_PYPROJECT },
      'urllib3',
      '1.0"; rm -rf /',
    );
    expect(badVersion.kind).toBe('refused');
  });
});

describe('declareDependency: probe parsing and the per-manager install command', () => {
  it('parses pip index versions output (header line, then the fallback list), null on garbage', () => {
    expect(
      declare.parseProbeOutput(
        'WARNING: pip index is currently an experimental command.\n' +
          'requests (2.32.5)\nAvailable versions: 2.32.5, 2.32.4\n',
      ),
    ).toBe('2.32.5');
    expect(declare.parseProbeOutput('Available versions: 6.0.2, 6.0.1\n')).toBe('6.0.2');
    for (const garbage of ['', 'npm error 404', '\n\n', 'not-a-version']) {
      expect(declare.parseProbeOutput(garbage)).toBeNull();
    }
  });

  it('probes the DISTRIBUTION the alias table names, never the raw import', () => {
    const probe = declare.versionProbe({ cwd: os.tmpdir(), rootDir: '', specifier: 'yaml' });
    expect(probe).toEqual({ bin: 'pip', args: ['index', 'versions', 'pyyaml'] });
  });

  it('the install command follows the owning root strategy manager, dev section included', () => {
    const ctx = { rootDir: '', specifier: 'yaml', version: '6.0.2', dev: false };
    const uv = rootWith({ 'uv.lock': '', 'pyproject.toml': UV_PYPROJECT });
    expect(declare.installCommand({ ...ctx, cwd: uv })).toEqual({
      bin: 'uv',
      args: ['add', 'pyyaml==6.0.2'],
    });
    expect(declare.installCommand({ ...ctx, cwd: uv, dev: true })).toEqual({
      bin: 'uv',
      args: ['add', '--dev', 'pyyaml==6.0.2'],
    });
    const poetry = rootWith({ 'poetry.lock': '', 'pyproject.toml': POETRY_PYPROJECT });
    expect(declare.installCommand({ ...ctx, cwd: poetry, dev: true })).toEqual({
      bin: 'poetry',
      args: ['add', '--group', 'dev', 'pyyaml==6.0.2'],
    });
    const pipenv = rootWith({ 'Pipfile.lock': '', Pipfile: PIPFILE });
    expect(declare.installCommand({ ...ctx, cwd: pipenv })).toEqual({
      bin: 'pipenv',
      args: ['install', 'pyyaml==6.0.2'],
    });
  });
});
