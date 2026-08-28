/**
 * How a Cargo root installs (CLAUDE.md Rule 6), the go-install.ts sibling,
 * split out of `rust.ts` so the remediation capabilities read the SAME
 * strategy without a module cycle.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - Cargo.lock is the lockfile and cargo itself maintains it; dxkit
 *     never hand-edits Cargo.toml or Cargo.lock.
 *   - The frozen install is `cargo fetch --locked`: it downloads exactly
 *     the locked dependency graph and FAILS when Cargo.lock is missing or
 *     does not record the manifest, the same refusal CI's `--locked`
 *     builds ride.
 *   - The resync is `cargo update --workspace`: the MINIMAL lock rewrite
 *     (re-resolve so the lockfile records the manifests, holding
 *     third-party packages at their locked versions where the constraints
 *     allow). `cargo generate-lockfile` was deliberately not chosen: on
 *     an existing lockfile it re-resolves everything to the latest
 *     available versions, churn a lockfile-sync fix must not smuggle in.
 *   - The sync check is `cargo update --workspace --locked --dry-run`:
 *     `--locked` asserts the lockfile would not change, `--dry-run` keeps
 *     even a surprising path from writing, and the minimal `--workspace`
 *     resolution keeps the answer scoped to "does the lock record the
 *     manifests". Small output on success (the metadata dump alternative
 *     can outrun the capture buffer on large workspaces).
 *   - No ecosystem tolerance exists here: cargo's resolver has no
 *     peer-check analogue, so no repo-authorized fallbacks are declared.
 */
import type { ExecutionRequirement } from '../execution';
import { declareInstallStrategy } from './capabilities/install-strategy';

/** Lockfile maintenance runs on the ambient Rust toolchain, any host, no
 *  build (`cargo fetch` / `cargo update` resolve and download only). */
export const CARGO_LOCK_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: ['rust'],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

export const rustInstallStrategy = declareInstallStrategy(
  [
    {
      when: ['Cargo.toml'],
      strategy: {
        manager: 'cargo',
        lockfile: 'Cargo.lock',
        modes: {
          frozen: { primary: { bin: 'cargo', args: ['fetch', '--locked'] }, fallbacks: [] },
          resync: { primary: { bin: 'cargo', args: ['update', '--workspace'] }, fallbacks: [] },
        },
        syncCheck: {
          kind: 'command',
          command: { bin: 'cargo', args: ['update', '--workspace', '--locked', '--dry-run'] },
          tolerates: [],
        },
        execution: CARGO_LOCK_EXECUTION,
      },
    },
  ],
  { ciDependencyInstall: false },
);
