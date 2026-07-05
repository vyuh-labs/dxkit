/**
 * Benign security conventions — the false-positive floor every template repo
 * starts with. These cases are drawn directly from round-3 dogfood feedback on a
 * Payload/Next.js template: `.env.example` flagged as a leaked env file, and
 * `password: 'password'` / `apiKey = 'your-api-key'` flagged as secrets. The
 * module is the ONE source of truth both the gitleaks provider and the
 * env-in-git count consult.
 */

import { describe, it, expect } from 'vitest';
import { isExampleEnvFile, isPlaceholderSecret } from '../src/analyzers/security/benign';

describe('isExampleEnvFile — example/template env conventions are not leaks', () => {
  for (const f of [
    '.env.example',
    '.env.sample',
    '.env.template',
    '.env.dist',
    '.env.defaults',
    '.env.local.example',
    'config/.env.example',
    'env.example',
  ]) {
    it(`treats ${f} as an example (not a committed secret)`, () => {
      expect(isExampleEnvFile(f)).toBe(true);
    });
  }

  for (const f of ['.env', '.env.local', '.env.production', 'src/config.ts', 'README.md']) {
    it(`does NOT exempt ${f} (a real env file / unrelated file still counts)`, () => {
      expect(isExampleEnvFile(f)).toBe(false);
    });
  }
});

describe('isPlaceholderSecret — demo/placeholder values are not credentials', () => {
  for (const v of [
    'password',
    'test',
    'changeme',
    'secret',
    'your-api-key',
    'your_secret_here',
    '<your-key>',
    '${API_KEY}',
    '{{TOKEN}}',
    '%SECRET%',
    'xxxxxxx',
    '*****',
    'placeholder',
    '',
  ]) {
    it(`flags ${JSON.stringify(v)} as a placeholder`, () => {
      expect(isPlaceholderSecret(v)).toBe(true);
    });
  }

  for (const v of [
    // Opaque, high-entropy values (NOT provider-prefixed, to avoid tripping
    // real secret scanners on this test) — a real credential shape.
    'a7f3c9d2b8e1f04a6c3e9b1d7f2a8c04',
    'Zx9Kp2mQ7rTvB4nW8sL1jF6hD3gY5cA',
    'kJ8s-Lm2p_Qr9t.Vn4w',
    'a7f3c9d2b8e1', // opaque hex, not a repeated char
  ]) {
    it(`does NOT flag a real-looking secret ${JSON.stringify(v)} (no false negative)`, () => {
      expect(isPlaceholderSecret(v)).toBe(false);
    });
  }
});
