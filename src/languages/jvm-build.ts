/**
 * Shared JVM build-tool glue for the correctness floor (CLAUDE.md Rule 2 — one
 * gather/command-builder, consumed by every pack that needs it). Both the Java
 * and Kotlin packs run on the same two build systems (Maven, Gradle) with the
 * same multi-module affected unit — the MODULE — so the compile + affected-test
 * command construction lives here once and is parameterized only by which source
 * extensions count as a "relevant change".
 *
 * The floor's two commands:
 *   - syntaxCheck: compile the whole reactor/build (main + test sources). Cheap,
 *     incremental via the build tool's cache, bounded by the runner's timeout
 *     (fail-open → CI backstop). Not narrowed — compile is fast and a partial
 *     compile can miss a cross-module break.
 *   - affectedTests: run the changed MODULES' tests. Maven narrows via
 *     `-pl <modules> -am`; Gradle via `:<project>:test`. A single-module project
 *     (no sub-manifests) runs the whole build — that IS its affected surface, the
 *     same way Rust's single-crate `cargo test` is. A build-file change anywhere,
 *     or a source file that can't be attributed to a sub-module, falls back to
 *     the whole build (never silently under-tests). Cross-module DEPENDENTS of a
 *     change are caught at full/CI scope, not the affected surface — the same
 *     package/module-level rung as Go and C#.
 *
 * The wrapper (`gradlew`) is emitted as an ABSOLUTE path, not `./gradlew`: the
 * runner's availability check stats the bin against the process cwd while
 * execution uses the command cwd, so a relative wrapper path would be checked in
 * the wrong directory. An absolute path is the resolved-path form the runner
 * explicitly supports (venv python, findTool paths).
 */

import * as fs from 'fs';
import * as path from 'path';

import { fileExists } from '../analyzers/tools/runner';
import type {
  CorrectnessCommand,
  CorrectnessContext,
  CorrectnessProvider,
} from './capabilities/correctness';

type JvmBuildSystem = 'maven' | 'gradle';

interface JvmBuild {
  readonly system: JvmBuildSystem;
  /** `mvn`, an absolute `gradlew` wrapper path, or bare `gradle`. */
  readonly bin: string;
}

/** Per-system sub-module manifest filenames (a directory owning one of these is
 *  a build module we can narrow to). */
const MODULE_MANIFESTS: Record<JvmBuildSystem, readonly string[]> = {
  maven: ['pom.xml'],
  gradle: ['build.gradle', 'build.gradle.kts'],
};

/** Any build-descriptor filename. A change to one of these can affect any
 *  module (a dependency/plugin/version bump), so it disqualifies narrowing. */
const JVM_BUILD_FILES = [
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradle.properties',
  'libs.versions.toml',
];

/** The absolute Gradle wrapper path when present, else bare `gradle` (PATH). */
function gradleBin(cwd: string): string {
  const wrapper = path.join(cwd, 'gradlew');
  return fs.existsSync(wrapper) ? wrapper : 'gradle';
}

/** Detect the build system rooted at cwd. Maven-first when both are present
 *  (rare); null when neither manifest exists — the floor then skips. */
function detectJvmBuild(cwd: string): JvmBuild | null {
  if (fileExists(cwd, 'pom.xml')) return { system: 'maven', bin: 'mvn' };
  if (
    fileExists(cwd, 'build.gradle') ||
    fileExists(cwd, 'build.gradle.kts') ||
    fileExists(cwd, 'gradlew') ||
    fileExists(cwd, 'settings.gradle') ||
    fileExists(cwd, 'settings.gradle.kts')
  ) {
    return { system: 'gradle', bin: gradleBin(cwd) };
  }
  return null;
}

function isJvmBuildFile(rel: string): boolean {
  const base = rel.replace(/\\/g, '/').split('/').pop() ?? '';
  return JVM_BUILD_FILES.includes(base);
}

/**
 * Is this an Android Gradle build? The Android Gradle Plugin replaces the
 * standard `test` / `testClasses` lifecycle tasks with variant-specific ones
 * (`testDebugUnitTest`, `compileDebugKotlin`, …), so the plain commands this
 * module builds don't apply — an Android project should decline the floor and
 * let CI (which knows the variant) backstop, rather than false-fail on a
 * "task not found". Cheap signal: the `com.android.*` plugin in a root build
 * file. Exported so both JVM packs share the one detector.
 */
export function isAndroidGradleBuild(cwd: string): boolean {
  for (const rel of [
    'build.gradle.kts',
    'build.gradle',
    'settings.gradle.kts',
    'settings.gradle',
  ]) {
    if (!fileExists(cwd, rel)) continue;
    try {
      if (fs.readFileSync(path.join(cwd, rel), 'utf-8').includes('com.android')) return true;
    } catch {
      /* ignore unreadable */
    }
  }
  return false;
}

/**
 * The repo-relative directory of the nearest ANCESTOR sub-module owning
 * `relFile` — the closest directory (below the root) that carries a module
 * manifest. Returns null when the nearest manifest is the root itself (a
 * root-level change affects the whole build) or none is found.
 */
function nearestModuleDir(
  cwd: string,
  relFile: string,
  manifests: readonly string[],
): string | null {
  let dir = path.dirname(relFile).replace(/\\/g, '/');
  for (;;) {
    if (dir === '.' || dir === '') return null; // reached the root → not a sub-module
    try {
      const entries = fs.readdirSync(path.join(cwd, dir));
      if (entries.some((f) => manifests.includes(f))) return dir;
    } catch {
      /* dir unreadable — keep walking up */
    }
    dir = path.dirname(dir);
  }
}

/**
 * The distinct sub-module directories owning the changed source files. Returns
 * null when ANY changed source file can't be attributed to a sub-module (it
 * lives at the root, or the project is single-module) — the caller then runs the
 * whole build, never under-testing.
 */
function jvmChangedModules(
  cwd: string,
  changedSources: readonly string[],
  manifests: readonly string[],
): string[] | null {
  const mods = new Set<string>();
  for (const f of changedSources) {
    const mod = nearestModuleDir(cwd, f, manifests);
    if (mod === null) return null; // root-level / single-module → whole build
    mods.add(mod);
  }
  return [...mods];
}

/** Whole-build compile (main + test sources). */
function compileCommand(build: JvmBuild): CorrectnessCommand {
  if (build.system === 'maven') {
    return { label: 'compile', bin: build.bin, args: ['-q', '-B', 'test-compile'] };
  }
  // Unqualified `testClasses` runs in every subproject that has it (Gradle
  // executes an unqualified task name across the root + all subprojects), so it
  // compiles main + test for the whole build without the root needing the task.
  return { label: 'compile', bin: build.bin, args: ['testClasses'] };
}

/** Whole-build test run (the `full`-scope and safe-fallback command). */
function testCommandFull(build: JvmBuild): CorrectnessCommand {
  if (build.system === 'maven') {
    return { label: 'affected-tests', bin: build.bin, args: ['-q', '-B', 'test'] };
  }
  return { label: 'affected-tests', bin: build.bin, args: ['test'] };
}

/** Narrowed test run over the given sub-module directories. */
function testCommandForModules(build: JvmBuild, mods: readonly string[]): CorrectnessCommand {
  if (build.system === 'maven') {
    // -pl takes a comma-joined list of module paths; -am also-makes (compiles)
    // the upstream dependencies of the listed modules so their tests can build.
    return {
      label: 'affected-tests',
      bin: build.bin,
      args: ['-q', '-B', '-pl', mods.join(','), '-am', 'test'],
    };
  }
  // Gradle project path: `a/b` → `:a:b`, task `:a:b:test`.
  const tasks = mods.map((d) => `:${d.replace(/\\/g, '/').split('/').join(':')}:test`);
  return { label: 'affected-tests', bin: build.bin, args: tasks };
}

export interface JvmCorrectnessOptions {
  /** Extensions that count as a relevant source change (`.java`, `.kt`/`.kts`). */
  readonly sourceExtensions: readonly string[];
  /** Optional escape hatch: decline the floor entirely when true (e.g. an
   *  Android Gradle build, whose variant-specific `testDebugUnitTest` tasks the
   *  standard `test`/`testClasses` commands don't cover — CI backstops). */
  readonly declineWhen?: (cwd: string) => boolean;
}

/**
 * Build a `CorrectnessProvider` for a JVM language pack. Shared by the Java and
 * Kotlin packs (CLAUDE.md Rule 2) — the two differ only in which extensions mark
 * a relevant change and whether an Android build should decline.
 */
export function jvmCorrectnessProvider(opts: JvmCorrectnessOptions): CorrectnessProvider {
  const isSource = (f: string): boolean => opts.sourceExtensions.some((e) => f.endsWith(e));

  return {
    syntaxCheck(ctx: CorrectnessContext): CorrectnessCommand | null {
      if (opts.declineWhen?.(ctx.cwd)) return null;
      const build = detectJvmBuild(ctx.cwd);
      if (!build) return null;
      return compileCommand(build);
    },

    affectedTests(ctx: CorrectnessContext): CorrectnessCommand | null {
      if (opts.declineWhen?.(ctx.cwd)) return null;
      const build = detectJvmBuild(ctx.cwd);
      if (!build) return null;

      const undeterminable = ctx.changedFiles.length === 0;
      if (ctx.scope !== 'affected' || undeterminable) return testCommandFull(build);

      const changedSources = ctx.changedFiles.filter(isSource);
      if (changedSources.length === 0) return null; // no relevant source change → skip
      // A build-descriptor change can affect any module — don't narrow.
      if (ctx.changedFiles.some(isJvmBuildFile)) return testCommandFull(build);

      const mods = jvmChangedModules(ctx.cwd, changedSources, MODULE_MANIFESTS[build.system]);
      if (mods && mods.length > 0) return testCommandForModules(build, mods);
      return testCommandFull(build); // single-module / unattributable → whole build
    },
  };
}
