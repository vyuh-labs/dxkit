/**
 * SDK compatibility handshake.
 *
 * An extension declares the SDK major it targets (in its manifest or its
 * `defineExtension` metadata); dxkit compares against this constant and warns
 * or refuses on a mismatch. The surface is additive-only within a major
 * (see the package README's versioning contract), so a matching major is a
 * sufficient compatibility check.
 *
 * Pinned by `test/sdk-surface-freeze.test.ts` in the main repo, which also
 * asserts this constant agrees with the package.json version.
 */
export const SDK_MAJOR = 0;
