/**
 * Android-Gradle detection (`isAndroidGradleBuild`) — the JVM packs'
 * correctness-floor `declineWhen`. If this misses, the kotlin/java floor
 * runs plain `gradlew testClasses` on an Android repo and fails on
 * variant-specific tasks (or worse, on infrastructure) — the T2.4 rollout
 * bug: a modern catalog-based repo carries the `com.android` literal ONLY
 * in gradle/libs.versions.toml (`alias(libs.plugins.android.application)`
 * in build files), which the root-build-file sniff never saw.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { isAndroidGradleBuild } from '../src/languages/jvm-build';

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
