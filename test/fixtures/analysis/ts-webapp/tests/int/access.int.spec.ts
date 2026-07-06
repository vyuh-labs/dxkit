// Integration test that imports the module under test by its `@/` alias.
// The import-graph matcher must resolve this alias to `src/authz/access.ts`,
// so the source file is credited as tested — not flagged as an untested gap.
import { describe, it, expect } from 'vitest';
import { canAccess } from '@/authz/access';

describe('access (integration)', () => {
  it('admin can access any resource', () => {
    expect(canAccess({ userId: 'u1', resource: 'billing' }, ['admin'])).toBe(true);
  });

  it('a matching role grants access', () => {
    expect(canAccess({ userId: 'u2', resource: 'reports' }, ['reports'])).toBe(true);
  });

  it('an unrelated role is denied', () => {
    expect(canAccess({ userId: 'u3', resource: 'billing' }, ['reports'])).toBe(false);
  });
});
