/**
 * How a Go module root installs (CLAUDE.md Rule 6), the
 * node-install.ts / python-install.ts sibling, split out of `go.ts` so the
 * remediation capabilities read the SAME strategy without a module cycle.
 *
 * Doctrine notes, kept beside the declarations they explain:
 *   - go.sum is the lockfile: it records the checksums of every module the
 *     build reads, and the go tool itself maintains it (go.mod + go.sum
 *     are never hand-edited by dxkit anywhere).
 *   - The frozen install is `go mod download`: it fetches exactly what
 *     go.mod resolves and FAILS on a checksum mismatch against go.sum,
 *     which is what every Go CI runs before building.
 *   - The resync is `go mod tidy`: the one command that rewrites go.mod +
 *     go.sum to record precisely what the source imports.
 *   - The sync check is `go mod tidy -diff` (go 1.23+): the non-writing
 *     dry-run that exits non-zero with the diff when go.mod / go.sum do
 *     not record the source's imports. On an older toolchain the flag is
 *     rejected ("flag provided but not defined"); the declared
 *     classifier names that as a toolchain-age condition instead of
 *     letting it read as lockfile drift (every supported Go release
 *     carries the flag; the shape only appears on an EOL toolchain).
 *   - No ecosystem tolerance exists here: the go resolver has no
 *     peer-check analogue, so no repo-authorized fallbacks are declared.
 */
import type { ExecutionRequirement } from '../execution';
import { declareInstallStrategy } from './capabilities/install-strategy';

/** Module maintenance runs on the ambient Go toolchain, any host, no
 *  build (`go mod` subcommands resolve and download, they do not compile). */
export const GO_MOD_EXECUTION: ExecutionRequirement = {
  hosts: ['any'],
  toolchains: ['go'],
  needsBuild: false,
  buildTarget: 'none',
  weight: 'cheap',
};

export const goInstallStrategy = declareInstallStrategy(
  [
    {
      when: ['go.mod'],
      strategy: {
        manager: 'gomod',
        lockfile: 'go.sum',
        modes: {
          frozen: { primary: { bin: 'go', args: ['mod', 'download'] }, fallbacks: [] },
          resync: { primary: { bin: 'go', args: ['mod', 'tidy'] }, fallbacks: [] },
        },
        syncCheck: {
          kind: 'command',
          command: { bin: 'go', args: ['mod', 'tidy', '-diff'] },
          tolerates: [],
          // A rejected -diff flag is a toolchain-age fact, not drift: name
          // it so an EOL Go install is never read, or remediated, as an
          // out-of-sync module file.
          classifyFailure: (output) =>
            /flag provided but not defined.*-diff|unknown flag.*-diff/i.test(output)
              ? 'toolchain-age: this Go toolchain predates go 1.23 (go mod tidy -diff), so the ' +
                'module-sync state cannot be judged here; update the Go toolchain.'
              : null,
        },
        execution: GO_MOD_EXECUTION,
      },
    },
  ],
  { ciDependencyInstall: false },
);
