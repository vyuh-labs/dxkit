/**
 * Suite-wide environment defaults.
 *
 * DXKIT_BASELINE_NO_FLOOR: `createBaseline` captures the floor-debt
 * envelope (a full compile + test pass) by DEFAULT in the product — but the
 * suite calls `createBaseline` on hundreds of throwaway fixture repos, and
 * paying a floor run per fixture would add minutes of pure noise (fixtures
 * have no real toolchain to measure). The env opt-out keeps the suite fast;
 * the capture path itself is exercised explicitly by
 * `test/baseline/floor-debt.test.ts`, which passes `floor: true` (an
 * explicit option always beats the env).
 */
process.env.DXKIT_BASELINE_NO_FLOOR = '1';
