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
 * `health` declares the present-but-unusable class (the F-14 shape: an SDK on
 * PATH that cannot actually drive a build). The probe runs ONCE per
 * environment (memoized by `currentEnvironment`), in the SAME env dxkit's own
 * spawned commands run in — so a condition dxkit self-heals (the csharp
 * pack's `DOTNET_SYSTEM_GLOBALIZATION_INVARIANT` for libicu-less hosts) is
 * correctly healthy here, and the libicu class survives only as a
 * post-failure CLASSIFIER (`environmentFailurePatterns`) for commands that
 * ran without the healer.
 */

import { execFileSync } from 'child_process';
import { commandExists } from '../analyzers/tools/runner';
import type { ExecutionHost } from './requirement';

/** Classifier over a failed command's output: when `pattern` (a regex,
 *  case-insensitive) matches, the failure is ENVIRONMENT-shaped — the
 *  toolchain cannot serve this repo here — not a code finding. Bias the
 *  patterns hard toward false-NEGATIVE: a real compile error must never be
 *  reclassified as an environment boundary (the benign.ts discipline). */
export interface EnvironmentFailureSignature {
  readonly id: string;
  readonly pattern: string;
  /** What is wrong (human line). */
  readonly problem: string;
  /** The actionable remedy — a command or a setting, never a bare error. */
  readonly remedy: string;
}

/** A cheap toolchain self-check. Exit 0 ⇒ healthy. On failure, the FIRST
 *  matching signature names the problem; `fallback` covers an unmatched
 *  failure (present-but-not-functional is still a boundary, just a less
 *  specific one). */
export interface ToolchainHealth {
  readonly probe: {
    readonly bin: string;
    readonly args: readonly string[];
    /** Extra env for the probe — mirrors what dxkit sets when it spawns this
     *  toolchain itself, so the probe answers for OUR commands, not a bare
     *  shell's. */
    readonly env?: Readonly<Record<string, string>>;
  };
  readonly failures: readonly EnvironmentFailureSignature[];
  readonly fallback: { readonly problem: string; readonly remedy: string };
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
  /** Optional self-check (see `ToolchainHealth`). Omitted ⇒ PATH presence is
   *  the whole health story for this toolchain. */
  readonly health?: ToolchainHealth;
  /** Signatures that reclassify a FAILED capability command as an
   *  environment boundary (see `classifyEnvironmentFailure`). Omitted ⇒ a
   *  failure of a command needing this toolchain is always a real failure. */
  readonly environmentFailurePatterns?: readonly EnvironmentFailureSignature[];
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
    // A module can pin a `go` directive newer than the installed toolchain —
    // go build/vet then fails before compiling anything of the user's.
    environmentFailurePatterns: [
      {
        id: 'go-too-old',
        pattern: 'requires go >=|cannot find GOROOT',
        problem: "the repo's go.mod requires a newer Go toolchain than installed",
        remedy: 'upgrade Go to the version go.mod requires (https://go.dev/dl/)',
      },
    ],
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
    // rustc alone is not enough: linking needs the platform C toolchain, and
    // cargo refuses a crate graph pinned to a newer rustc. Both fail before
    // any of the user's code is judged — environment, not findings
    // (VERIFY-40 F-10: `linker cc not found` minted a lint finding AND
    // failed the correctness floor on pristine code).
    environmentFailurePatterns: [
      {
        id: 'rust-no-linker',
        pattern: 'linker `[^`]+` not found',
        problem: 'rustc cannot link: no platform C toolchain/linker on this host',
        remedy:
          'install the platform C toolchain (linux: `sudo apt-get install -y build-essential`; macos: `xcode-select --install`; windows: the Visual Studio Build Tools)',
      },
      {
        id: 'rust-too-old',
        pattern: 'requires rustc \\d|rustc [\\d.]+ is not supported',
        problem: 'a dependency requires a newer rustc than installed',
        remedy: 'upgrade the toolchain: `rustup update stable`',
      },
    ],
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
    health: {
      // Mirrors the csharp pack's own spawn env (`ensureDotnetInvariant`), so
      // a libicu-less host that dxkit self-heals probes HEALTHY — the probe
      // answers "can dxkit's dotnet commands run", not "is a bare shell fine".
      probe: {
        bin: 'dotnet',
        args: ['--list-sdks'],
        env: { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' },
      },
      failures: [
        {
          id: 'hostfxr-missing',
          pattern: 'libhostfxr|hostfxr\\.dll|A fatal error occurred.*required library',
          problem:
            'the dotnet host cannot find its runtime (partial install or DOTNET_ROOT mismatch)',
          remedy:
            'reinstall via `dotnet-install.sh --install-dir $HOME/.dotnet` and ensure DOTNET_ROOT points at it',
        },
      ],
      fallback: {
        problem: 'dotnet is on PATH but not functional (`dotnet --list-sdks` failed)',
        remedy:
          'reinstall the SDK: `curl -fsSL https://dot.net/v1/dotnet-install.sh | bash -s -- --install-dir $HOME/.dotnet`',
      },
    },
    // The F-14 class: an SDK that lists fine but cannot serve THIS repo's
    // build. Every pattern is strictly SDK/environment-shaped (never a
    // compiler diagnostic) so a real compile error stays a real failure.
    environmentFailurePatterns: [
      {
        id: 'sdk-too-old',
        pattern: 'NETSDK1045',
        problem: 'the repo targets a newer .NET than the installed SDK supports',
        remedy:
          'install the SDK the repo targets (see `global.json` / the csproj TargetFramework), e.g. `dotnet-install.sh --channel <version>`',
      },
      {
        id: 'sdk-unresolvable',
        pattern: 'MSB4236|compatible \\.NET SDK is not installed|not found or a compatible',
        problem: 'MSBuild cannot resolve a usable .NET SDK for this project',
        remedy: 'install the SDK the repo targets, or pin it with `global.json`',
      },
      {
        id: 'libicu',
        pattern: 'ICU package',
        problem: 'dotnet aborted: no libicu on this host (globalization support)',
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
    // Build tools and compiled classes fail on a JVM older than what the
    // build (or Gradle itself) was compiled for — an environment fact.
    environmentFailurePatterns: [
      {
        id: 'jdk-too-old',
        pattern: 'Unsupported class file major version|UnsupportedClassVersionError',
        problem: 'the installed JDK is older than what this build requires',
        remedy:
          'install the JDK the repo targets (e.g. `winget install Microsoft.OpenJDK.21` / adoptium.net)',
      },
    ],
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

/** A present-but-unusable diagnosis: the named problem and its remedy. */
export interface ToolchainProblem {
  readonly problem: string;
  readonly remedy: string;
}

/** Injected probe exec (tests). Returns the exit code and combined output;
 *  a spawn error is a non-zero code with the error text as output. */
export type ProbeExec = (
  bin: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => { code: number; output: string };

const defaultProbeExec: ProbeExec = (bin, args, env) => {
  try {
    const stdout = execFileSync(bin, [...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      env: { ...process.env, ...env },
    });
    return { code: 0, output: stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      output: [e.stdout, e.stderr, e.message].filter(Boolean).join('\n'),
    };
  }
};

/**
 * Run a PRESENT toolchain's declared health probe — the ONE home of health
 * execution (memoized per environment by `currentEnvironment`, never here).
 * Returns null when healthy (probe exits 0, or the toolchain declares no
 * probe); otherwise the first matching failure signature's diagnosis, else
 * the declared fallback — a failed probe is ALWAYS a named boundary, never a
 * silent pass (present-but-broken was F-14's disguise).
 */
export function toolchainHealthProblem(
  id: ToolchainId,
  exec: ProbeExec = defaultProbeExec,
): ToolchainProblem | null {
  const health = (TOOLCHAIN_DEFS[id] as ToolchainDef).health;
  if (!health) return null;
  const { code, output } = exec(health.probe.bin, health.probe.args, health.probe.env);
  if (code === 0) return null;
  for (const sig of health.failures) {
    if (new RegExp(sig.pattern, 'i').test(output)) {
      return { problem: sig.problem, remedy: sig.remedy };
    }
  }
  return health.fallback;
}

/**
 * Classify a FAILED capability command's output against the declared
 * environment-failure signatures of the toolchains it runs on. Returns the
 * matched toolchain + diagnosis when the failure is environment-shaped (the
 * F-14 class: `dotnet build` failing on SDK resolution, not on the user's
 * code), else null — and null is the DEFAULT: a real compile error, a failing
 * test, a genuine lint diagnostic must never be reclassified as an
 * environment boundary. The signatures are declared per toolchain in this
 * registry (strictly SDK/environment-shaped, biased false-negative), so the
 * classifier has one home and both runners share it.
 */
export function classifyEnvironmentFailure(
  toolchains: readonly ToolchainId[],
  output: string,
): { toolchain: ToolchainId; problem: string; remedy: string } | null {
  if (!output) return null;
  for (const id of toolchains) {
    for (const sig of (TOOLCHAIN_DEFS[id] as ToolchainDef).environmentFailurePatterns ?? []) {
      if (new RegExp(sig.pattern, 'i').test(output)) {
        return { toolchain: id, problem: sig.problem, remedy: sig.remedy };
      }
    }
  }
  return null;
}

/** The registry toolchain whose binaries include `bin`, if any — lets doctor
 *  map a missing cliBinary to its per-host install remedy. */
export function toolchainForBinary(bin: string): ToolchainDef | null {
  for (const def of Object.values(TOOLCHAIN_DEFS) as ToolchainDef[]) {
    if (def.binaries.includes(bin)) return def;
  }
  return null;
}

/** The install command for a toolchain on a host — the actionable remedy line
 *  renderers surface instead of a raw "not recognized" error. */
export function toolchainInstallHint(id: ToolchainId, host: ExecutionHost): string {
  const def = TOOLCHAIN_DEFS[id];
  return def.install[host] ?? def.install.fallback;
}
