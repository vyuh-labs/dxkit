import { describe, it, expect } from 'vitest';
import { rawSecretsToBaselineEntries } from '../../../src/baseline/producers/secret-hmac';
import type { GitleaksRawSecret } from '../../../src/analyzers/tools/gitleaks';
import { computeSecretHmac } from '../../../src/analyzers/tools/fingerprint';
import { identityFor } from '../../../src/baseline/finding-identity';

const SALT = 'fixture-salt-abc123';

function raw(over: Partial<GitleaksRawSecret> = {}): GitleaksRawSecret {
  return {
    file: 'src/config.ts',
    line: 42,
    rule: 'generic-api-key',
    secret: 'sk-test-1234567890',
    ...over,
  };
}

describe('rawSecretsToBaselineEntries', () => {
  it('emits no entries for an empty input', () => {
    expect(rawSecretsToBaselineEntries({ rawSecrets: [], salt: SALT })).toEqual([]);
  });

  it('emits one secret-hmac entry per raw secret', () => {
    const entries = rawSecretsToBaselineEntries({
      rawSecrets: [raw(), raw({ secret: 'another-secret' })],
      salt: SALT,
    });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.kind === 'secret-hmac')).toBe(true);
  });

  it('uses the canonical HMAC primitive + identity dispatch', () => {
    const r = raw();
    const [entry] = rawSecretsToBaselineEntries({ rawSecrets: [r], salt: SALT });
    expect(entry.kind).toBe('secret-hmac');
    if (entry.kind !== 'secret-hmac') return;
    const expectedHmac = computeSecretHmac(r.secret, SALT);
    expect(entry.hmac).toBe(expectedHmac);
    expect(entry.id).toBe(
      identityFor({ kind: 'secret-hmac', tool: 'gitleaks', rule: r.rule, hmac: expectedHmac }),
    );
  });

  it('produces the same HMAC for the same secret + salt', () => {
    const r = raw();
    const [a] = rawSecretsToBaselineEntries({ rawSecrets: [r], salt: SALT });
    const [b] = rawSecretsToBaselineEntries({ rawSecrets: [r], salt: SALT });
    if (a.kind !== 'secret-hmac' || b.kind !== 'secret-hmac') throw new Error('shape');
    expect(a.hmac).toBe(b.hmac);
  });

  it('produces a different HMAC when the salt changes', () => {
    const r = raw();
    const [a] = rawSecretsToBaselineEntries({ rawSecrets: [r], salt: 'salt-a' });
    const [b] = rawSecretsToBaselineEntries({ rawSecrets: [r], salt: 'salt-b' });
    if (a.kind !== 'secret-hmac' || b.kind !== 'secret-hmac') throw new Error('shape');
    expect(a.hmac).not.toBe(b.hmac);
  });

  it('produces the same HMAC for the same secret moved to a different file', () => {
    const a = raw({ file: 'src/a.ts', line: 1 });
    const b = raw({ file: 'src/b.ts', line: 99 });
    const [ea] = rawSecretsToBaselineEntries({ rawSecrets: [a], salt: SALT });
    const [eb] = rawSecretsToBaselineEntries({ rawSecrets: [b], salt: SALT });
    if (ea.kind !== 'secret-hmac' || eb.kind !== 'secret-hmac') throw new Error('shape');
    expect(ea.hmac).toBe(eb.hmac);
    expect(ea.id).toBe(eb.id);
  });

  it('skips entries with an empty secret value (defensive)', () => {
    const entries = rawSecretsToBaselineEntries({
      rawSecrets: [raw(), raw({ secret: '' })],
      salt: SALT,
    });
    expect(entries).toHaveLength(1);
  });

  it('does not leak the raw secret value into any emitted entry', () => {
    const entries = rawSecretsToBaselineEntries({
      rawSecrets: [raw({ secret: 'NEVER-WRITE-THIS-TO-DISK' })],
      salt: SALT,
    });
    expect(JSON.stringify(entries)).not.toContain('NEVER-WRITE-THIS-TO-DISK');
  });
});
