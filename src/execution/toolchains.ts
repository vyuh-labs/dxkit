/**
 * The toolchain-provisioning registry — ambient SDKs / runtimes that
 * capabilities may require (`ExecutionRequirement.toolchains`), declared once
 * with per-host installation and health facts (CLAUDE.md Rule 20).
 *
 * This is the toolchain sibling of the TOOL registry (Rule 1): `TOOL_DEFS`
 * owns scanners dxkit can install itself (`tools install`); `TOOLCHAIN_DEFS`
 * owns the ecosystems' own SDKs, which dxkit never installs unasked — it
 * DETECTS them, NAMES the per-host install when one is missing, and (in the
 * placement increment) routes the capability to an environment that has them.
 * The boundary: if `tools install` can provision it, it is a tool; if the
 * repo's ecosystem provisions it, it is a toolchain.
 *
 * Install commands prefer a NON-PRIVILEGED default per host (the
 * `dotnet-install.sh --install-dir $HOME/.dotnet` class — the same paths
 * `getSystemPaths()` already probes), and `fallback` is a URL that works when
 * no package manager does. Never surface a raw "command not recognized" from
 * a package manager the host doesn't have — name the remedy from THIS
 * registry.
 *
 * `healthChecks` declares the present-but-unusable class (dotnet on a
 * libicu-less Linux). This increment declares them; the provisioning
 * increment executes them and mints `unhealthy-toolchain` boundaries.
 */

import { commandExists } from '../analyzers/tools/runner';
import type { ExecutionHost } from './requirement';

/** A declared way a present toolchain can still be unusable, with the probe
 *  a later increment runs and the remedy to name when it fails. */
export interface ToolchainHealthCheck {
  readonly id: string;
  /** What breaks when the check fails (human line). */
  readonly problem: string;
  /** The actionable remedy — a command or a setting, never a bare error. */
  readonly remedy: string;
}

export interface ToolchainDef {
  readonly id: string;
  readonly displayName: string;
  /** Binaries whose PATH presence means "this toolchain is available".
   *  First match wins; multiple entries cover per-host naming (python3 vs
   *  python). Probed via the canonical `commandExists` PATH walk — the same
   *  probe doctor's toolchain coverage uses, so the two surfaces cannot
   *  disagree about presence. */
  readonly binaries: readonly string[];
  /** Per-host install command (non-privileged default where one exists) and
   *  a fallback URL for hosts where no one-liner is honest. */
  readonly install: Partial<Record<ExecutionHost, string>> & { readonly fallback: string };
  readonly healthChecks?: readonly ToolchainHealthCheck[];
}

/**
 * The registry. `ToolchainId` is derived from it, so a pack declaring an
 * unregistered toolchain fails to COMPILE — the same closed-union discipline
 * `LanguageId` follows.
 */
export const TOOLCHAIN_DEFS = {
  node: {
    id: 'node',
    displayName: 'Node.js',
    binaries: ['node'],
    install: {
      linux:
        'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash && nvm install --lts',
      macos: 'brew install node',
      windows: 'winget install OpenJS.NodeJS.LTS',
      fallback: 'https://nodejs.org/en/download',
    },
  },
  python: {
    id: 'python',
    displayName: 'Python',
    binaries: ['python3', 'python'],
    install: {
      linux: 'sudo apt-get install -y python3 python3-pip # or your distro equivalent',
      macos: 'brew install python',
      windows: 'winget install Python.Python.3.12',
      fallback: 'https://www.python.org/downloads/',
    },
  },
  go: {
    id: 'go',
    displayName: 'Go',
    binaries: ['go'],
    install: {
      // Non-sudo default: the tarball into a user-owned toolchain dir (the
      // path the 3.9 evaluation provisioned by hand and getSystemPaths probes
      // via PATH).
      linux:
        'curl -fsSL https://go.dev/dl/go1.22.5.linux-amd64.tar.gz | tar -C $HOME/.local/toolchains -xz && export PATH="$HOME/.local/toolchains/go/bin:$PATH"',
      macos: 'brew install go',
      windows: 'winget install GoLang.Go',
      fallback: 'https://go.dev/dl/',
    },
  },
  rust: {
    id: 'rust',
    displayName: 'Rust',
    binaries: ['cargo', 'rustc'],
    install: {
      linux: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
      macos: 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
      windows: 'winget install Rustlang.Rustup',
      fallback: 'https://rustup.rs',
    },
  },
  'dotnet-sdk': {
    id: 'dotnet-sdk',
    displayName: '.NET SDK',
    binaries: ['dotnet'],
    install: {
      // Microsoft's recommended non-sudo path — installs to $HOME/.dotnet,
      // which getSystemPaths() already probes. Never `apt`/`scoop` first: the
      // class that shipped a raw "'scoop' is not recognized".
      linux:
        'curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --install-dir $HOME/.dotnet && export PATH="$HOME/.dotnet:$PATH"',
      macos: 'brew install dotnet-sdk',
      windows: 'winget install Microsoft.DotNet.SDK.9',
      fallback: 'https://dot.net/v1/dotnet-install.sh',
    },
    healthChecks: [
      {
        id: 'libicu',
        problem: 'dotnet aborts at startup on Linux hosts without libicu (globalization support)',
        remedy:
          'install libicu (e.g. `sudo apt-get install -y libicu-dev`) or set DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1',
      },
    ],
  },
  jdk: {
    id: 'jdk',
    displayName: 'JDK',
    binaries: ['java'],
    install: {
      linux:
        'curl -fsSL https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse | tar -C $HOME/.local/toolchains -xz',
      macos: 'brew install openjdk@21',
      windows: 'winget install Microsoft.OpenJDK.21',
      fallback: 'https://adoptium.net/temurin/releases/',
    },
  },
  maven: {
    id: 'maven',
    displayName: 'Maven',
    binaries: ['mvn'],
    install: {
      linux: 'sudo apt-get install -y maven # or use the repo-committed ./mvnw wrapper',
      macos: 'brew install maven',
      windows: 'winget install Apache.Maven',
      fallback: 'https://maven.apache.org/install.html',
    },
  },
  gradle: {
    id: 'gradle',
    displayName: 'Gradle',
    binaries: ['gradle'],
    install: {
      linux: 'sudo apt-get install -y gradle # or use the repo-committed ./gradlew wrapper',
      macos: 'brew install gradle',
      windows: 'winget install Gradle.Gradle',
      fallback: 'https://gradle.org/install/',
    },
  },
  ruby: {
    id: 'ruby',
    displayName: 'Ruby',
    binaries: ['ruby'],
    install: {
      linux: 'sudo apt-get install -y ruby-full # or rbenv for a user-local install',
      macos: 'brew install ruby',
      windows: 'winget install RubyInstallerTeam.Ruby.3.2',
      fallback: 'https://www.ruby-lang.org/en/documentation/installation/',
    },
  },
} as const satisfies Record<string, ToolchainDef>;

/** Closed union of registered toolchains — derived, never hand-maintained. */
export type ToolchainId = keyof typeof TOOLCHAIN_DEFS;

/** Is this toolchain present here? PATH-derived via the ONE canonical probe
 *  (`commandExists`), so this module, doctor, and the toolchain-coverage
 *  signal all answer presence identically. */
export function toolchainPresent(id: ToolchainId): boolean {
  return TOOLCHAIN_DEFS[id].binaries.some((bin) => commandExists(bin));
}

/** The install command for a toolchain on a host — the actionable remedy line
 *  renderers surface instead of a raw "not recognized" error. */
export function toolchainInstallHint(id: ToolchainId, host: ExecutionHost): string {
  const def = TOOLCHAIN_DEFS[id];
  return def.install[host] ?? def.install.fallback;
}
