/**
 * Android-Gradle detection (`androidGradleShape` / `isAndroidGradleBuild`) —
 * drives the JVM packs' variant-aware correctness floor. If detection misses,
 * the kotlin/java floor runs plain `gradlew testClasses` on an Android repo
 * and fails on variant-specific tasks (or worse, on infrastructure) — the
 * T2.4 rollout bug: a modern catalog-based repo carries the `com.android`
 * literal ONLY in gradle/libs.versions.toml
 * (`alias(libs.plugins.android.application)` in build files), which the
 * root-build-file sniff never saw.
 *
 * 4.1 (task #15): a PLAIN Android build no longer declines — the floor runs
 * Debug-variant commands (`compileDebugKotlin` / `testDebugUnitTest`). A
 * FLAVORED build still declines (its task names are flavor-qualified, so a
 * hardcoded Debug task would false-fail).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { androidGradleShape, isAndroidGradleBuild } from '../src/languages/jvm-build';
import { kotlin } from '../src/languages/kotlin';
import { java } from '../src/languages/java';

const dirs: string[] = [];
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dxkit-android-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('isAndroidGradleBuild', () => {
  it('detects the classic shape: com.android classpath in the root build file', () => {
    const dir = repo({
      'build.gradle':
        'buildscript { dependencies { classpath "com.android.tools.build:gradle:8.0.0" } }\n',
    });
    expect(isAndroidGradleBuild(dir)).toBe(true);
  });

  it('detects the VERSION-CATALOG shape — com.android only in libs.versions.toml (the shipped miss)', () => {
    const dir = repo({
      'build.gradle.kts': 'plugins { alias(libs.plugins.android.application) apply false }\n',
      'settings.gradle.kts': 'rootProject.name = "app"\ninclude(":app")\n',
      'gradle/libs.versions.toml':
        '[plugins]\nandroid-application = { id = "com.android.application", version.ref = "agp" }\n',
    });
    expect(isAndroidGradleBuild(dir)).toBe(true);
  });

  it('detects a first-level module declaring the plugin id directly', () => {
    const dir = repo({
      'settings.gradle.kts': 'include(":app")\n',
      'app/build.gradle.kts': 'plugins { id("com.android.application") }\n',
    });
    expect(isAndroidGradleBuild(dir)).toBe(true);
  });

  it('stays FALSE for a plain (non-Android) Gradle build — the floor must keep running there', () => {
    const dir = repo({
      'build.gradle.kts': 'plugins { kotlin("jvm") version "2.0.0" }\n',
      'settings.gradle.kts': 'rootProject.name = "svc"\n',
      'gradle/libs.versions.toml': '[versions]\nkotlin = "2.0.0"\n',
      'app/build.gradle.kts': 'plugins { application }\n',
    });
    expect(isAndroidGradleBuild(dir)).toBe(false);
  });
});

const ANDROID_PLAIN = {
  'settings.gradle.kts': 'include(":app")\n',
  'app/build.gradle.kts': 'plugins { id("com.android.application") }\n',
};

const ANDROID_FLAVORED = {
  'settings.gradle.kts': 'include(":app")\n',
  'app/build.gradle.kts':
    'plugins { id("com.android.application") }\n' +
    'android { flavorDimensions += "tier"\n  productFlavors { create("free") {}\n  create("pro") {} } }\n',
};

describe('androidGradleShape', () => {
  it('classifies plain vs flavored Android builds', () => {
    expect(androidGradleShape(repo(ANDROID_PLAIN))).toBe('plain');
    expect(androidGradleShape(repo(ANDROID_FLAVORED))).toBe('flavored');
    expect(androidGradleShape(repo({ 'build.gradle.kts': 'plugins { kotlin("jvm") }\n' }))).toBe(
      'none',
    );
  });
});

describe('Android variant-aware floor (4.1 task #15)', () => {
  it('kotlin floor runs Debug-variant commands on a plain Android build', () => {
    const dir = repo(ANDROID_PLAIN);
    const build = kotlin.correctness.syntaxCheck({ cwd: dir, changedFiles: [], scope: 'full' });
    expect(build).not.toBeNull();
    expect(build!.args).toEqual(['compileDebugKotlin']);
    const tests = kotlin.correctness.affectedTests({ cwd: dir, changedFiles: [], scope: 'full' });
    expect(tests!.args).toEqual(['testDebugUnitTest']);
  });

  it('kotlin floor narrows to the changed module, variant-qualified', () => {
    const dir = repo({
      ...ANDROID_PLAIN,
      'app/src/main/kotlin/Main.kt': 'fun main() {}\n',
    });
    const tests = kotlin.correctness.affectedTests({
      cwd: dir,
      changedFiles: ['app/src/main/kotlin/Main.kt'],
      scope: 'affected',
    });
    expect(tests!.args).toEqual([':app:testDebugUnitTest']);
  });

  it('java floor uses its own variant compile task on a plain Android build', () => {
    const dir = repo(ANDROID_PLAIN);
    const build = java.correctness.syntaxCheck({ cwd: dir, changedFiles: [], scope: 'full' });
    expect(build!.args).toEqual(['compileDebugJavaWithJavac']);
  });

  it('a FLAVORED Android build still declines (flavor-qualified task names)', () => {
    const dir = repo(ANDROID_FLAVORED);
    expect(kotlin.correctness.syntaxCheck({ cwd: dir, changedFiles: [], scope: 'full' })).toBe(
      null,
    );
    expect(kotlin.correctness.affectedTests({ cwd: dir, changedFiles: [], scope: 'full' })).toBe(
      null,
    );
  });

  it('a plain JVM Gradle build keeps the standard commands', () => {
    const dir = repo({ 'build.gradle.kts': 'plugins { kotlin("jvm") }\n' });
    const build = kotlin.correctness.syntaxCheck({ cwd: dir, changedFiles: [], scope: 'full' });
    expect(build!.args).toEqual(['testClasses']);
  });
});
