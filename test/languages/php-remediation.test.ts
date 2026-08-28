/**
 * The php remediation capabilities (4.4.7 V2): the composer exact-version
 * require pin as a pure JSON transform (applied / refused / adversarial),
 * the composer name rail, and the two reasoned exemptions (declare, lint
 * fix) carrying real reasons. No network, no spawns.
 */
import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { phpRemediation, isValidComposerPackageName } from '../../src/languages/php-remediation';
import type { PinTransitiveProvider } from '../../src/languages/capabilities/remediation';

const pin = (phpRemediation.pinTransitive as { provider: PinTransitiveProvider }).provider;

const COMPOSER_JSON = `{
  "name": "acme/app",
  "require": {
    "php": "^8.2",
    "guzzlehttp/guzzle": "^7.8"
  },
  "require-dev": {
    "phpunit/phpunit": "^11.0"
  }
}
`;

function planPin(pkg = 'guzzlehttp/psr7', version = '2.7.1') {
  return pin.plan({ cwd: os.tmpdir(), rootDir: '', pkg, version });
}

describe('pinTransitive: the composer exact-version require pin', () => {
  it('adds the require entry, preserving indentation and the trailing newline', () => {
    const plan = planPin();
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') return;
    expect(plan.edit.file).toBe('composer.json');
    const out = plan.edit.transform(COMPOSER_JSON);
    if (!('text' in out)) throw new Error(out.refused);
    const parsed = JSON.parse(out.text) as { require: Record<string, string> };
    expect(parsed.require['guzzlehttp/psr7']).toBe('2.7.1');
    expect(parsed.require['guzzlehttp/guzzle']).toBe('^7.8'); // untouched
    expect(out.text.endsWith('\n')).toBe(true);
    expect(out.text).toContain('  "require"'); // two-space style preserved
    expect(plan.revert).toContain('guzzlehttp/psr7');
    // The deliberate-churn disclosure rides the plan onto the ledger:
    // composer has no scoped lock resync, and the ledger says so.
    expect(plan.notes?.join(' ')).toContain('unrelated packages');
  });

  it('refuses a direct dependency (require or require-dev) and non-JSON text', () => {
    const direct = planPin('guzzlehttp/guzzle');
    if (direct.kind !== 'plan')
      throw new Error(direct.kind === 'refused' ? direct.reason : direct.kind);
    const d = direct.edit.transform(COMPOSER_JSON);
    expect(d).toHaveProperty('refused');
    if ('refused' in d) expect(d.refused).toContain('dep-bump');

    const dev = planPin('phpunit/phpunit');
    if (dev.kind !== 'plan') throw new Error(dev.kind === 'refused' ? dev.reason : dev.kind);
    expect(dev.edit.transform(COMPOSER_JSON)).toHaveProperty('refused');

    const p = planPin();
    if (p.kind !== 'plan') throw new Error(p.kind === 'refused' ? p.reason : p.kind);
    for (const garbage of ['', 'not a manifest {', '42', '[]']) {
      expect(p.edit.transform(garbage)).toHaveProperty('refused');
    }
  });

  it('refuses tokens outside the composer name/version shapes (Rule 11)', () => {
    expect(isValidComposerPackageName('monolog/monolog')).toBe(true);
    expect(isValidComposerPackageName('symfony/http-kernel')).toBe(true);
    for (const bad of ['', 'monolog', '-x/y', '--flag=x/y', 'A/B', 'a b/c', 'a/b/c']) {
      expect(isValidComposerPackageName(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(planPin('-x/y').kind).toBe('refused');
    expect(planPin('monolog/monolog', '3.7.0"; rm -rf /').kind).toBe('refused');
  });
});

describe('the reasoned exemptions carry their doctrine', () => {
  it('declareDependency: a namespace does not identify a Packagist package', () => {
    expect(phpRemediation.declareDependency.kind).toBe('exemption');
    if (phpRemediation.declareDependency.kind === 'exemption') {
      expect(phpRemediation.declareDependency.reason).toContain('namespace');
    }
  });

  it('lintFix: phpcbf cannot fix and verify in one run', () => {
    expect(phpRemediation.lintFix.kind).toBe('exemption');
    if (phpRemediation.lintFix.kind === 'exemption') {
      expect(phpRemediation.lintFix.reason).toContain('phpcbf');
    }
  });
});
