/**
 * Where a repo builds — one concept, four consumers (CLAUDE.md Rule 2.30 +
 * Rule 20): the generated devcontainer.json, the generated AGENTS.md, the
 * gates (placement + the runners' disclosure predicate) and `tools install`
 * must all read the same repo-intrinsic answer, `repoBuildsElsewhere`.
 *
 * The matrix covers the stacks that cannot build in dxkit's Linux container
 * (a classic .NET Framework solution, an SDK-style net48 / WinForms project, a
 * Unity project with and without committed csproj files, an iOS app with and
 * without a committed .xcodeproj) next to the look-alikes that CAN build there
 * (a portable .NET project, a multi-target library, a SwiftPM package, a Node
 * repo). Before 4.5.0 the classic and SDK-style .NET Framework repos read as
 * "builds anywhere" (the gate ran `dotnet build` on Linux), the Unity repo was
 * not detected at all, and neither generated surface said anything.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildElsewhereLines,
  collectExecutionRequirements,
  detectActiveLanguages,
  repoBuildsElsewhere,
  buildDevcontainerFeatures,
} from '../../src/languages';
import { csharp } from '../../src/languages/csharp';
import {
  buildCannotRunOn,
  describeBuildMachine,
  toolchainInstallableOn,
  unmetRequirement,
  hostOf,
  type ExecutionEnvironment,
} from '../../src/execution';
import { installDevcontainer, repoPlacementPlan } from '../../src/ship-installers';
import { generate } from '../../src/generator';
import { detect } from '../../src/detect';
import { findTool, TOOL_DEFS } from '../../src/analyzers/tools/tool-registry';
import type { ResolvedConfig } from '../../src/types';
import { clearWalkPathsCache } from '../../src/analyzers/tools/walk-paths';

const CLASSIC_CSPROJ = `<?xml version="1.0" encoding="utf-8"?>
<Project ToolsVersion="15.0" xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <Import Project="$(MSBuildExtensionsPath)\\$(MSBuildToolsVersion)\\Microsoft.Common.props" />
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFrameworkVersion>v4.7.2</TargetFrameworkVersion>
  </PropertyGroup>
  <Import Project="$(MSBuildToolsPath)\\Microsoft.CSharp.targets" />
</Project>
`;
const sdkProject = (props: string) =>
  `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${props}</PropertyGroup></Project>\n`;

type Files = Record<string, string>;
const UNITY: Files = {
  'ProjectSettings/ProjectVersion.txt': 'm_EditorVersion: 2022.3.20f1\n',
  'Assets/Scripts/Player.cs': 'using UnityEngine;\npublic class Player : MonoBehaviour {}\n',
  'Packages/manifest.json': '{"dependencies":{"com.unity.ugui":"1.0.0"}}\n',
};

const NETFX =
  'C#: Windows with Visual Studio Build Tools (MSBuild) and the .NET Framework 4.x developer pack';
const WINDOWS_SDK = 'C#: Windows with .NET SDK';
const UNITY_LINE = 'C#: a machine with Unity Editor';
const XCODE = 'Swift: macOS with Xcode';

/** name → files + the lines every surface must print (empty: builds here). */
const MATRIX: Record<string, { files: Files; lines: string[] }> = {
  'netfx-classic': {
    files: {
      'App.sln': 'Microsoft Visual Studio Solution File, Format Version 12.00\n',
      'App/App.csproj': CLASSIC_CSPROJ,
      'App/packages.config':
        '<?xml version="1.0"?>\n<packages><package id="Newtonsoft.Json" version="12.0.1" targetFramework="net472" /></packages>\n',
      'App/Form1.cs': 'class Form1 {}\n',
    },
    lines: [NETFX],
  },
  'netfx-sdk-style': {
    files: { 'Lib.csproj': sdkProject('<TargetFramework>net48</TargetFramework>'), 'A.cs': '' },
    lines: [WINDOWS_SDK],
  },
  winforms: {
    files: {
      'App.csproj': sdkProject(
        '<TargetFramework>net8.0-windows</TargetFramework><UseWindowsForms>true</UseWindowsForms>',
      ),
      'A.cs': '',
    },
    lines: [WINDOWS_SDK],
  },
  unity: { files: UNITY, lines: [UNITY_LINE] },
  'unity-committed-csproj': {
    files: { ...UNITY, 'Assembly-CSharp.csproj': CLASSIC_CSPROJ },
    lines: [UNITY_LINE],
  },
  'ios-xcodeproj': {
    files: {
      'App.xcodeproj/project.pbxproj': '{ buildSettings = { SDKROOT = iphoneos; }; }\n',
      'App/AppDelegate.swift': 'import UIKit\n',
      Podfile: "platform :ios, '15.0'\n",
    },
    lines: [XCODE],
  },
  'ios-podfile-generated-project': {
    files: {
      Podfile: "platform :ios, '15.0'\n",
      'project.yml': 'name: App\n',
      'App/AppDelegate.swift': 'import UIKit\n',
    },
    lines: [XCODE],
  },
  'portable-dotnet': {
    files: { 'App.csproj': sdkProject('<TargetFramework>net8.0</TargetFramework>'), 'A.cs': '' },
    lines: [],
  },
  'multi-target-library': {
    files: {
      'Lib.csproj': sdkProject('<TargetFrameworks>netstandard2.0;net48;net8.0</TargetFrameworks>'),
    },
    lines: [],
  },
  'swift-package': {
    files: {
      'Package.swift':
        '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "Lib", targets: [.target(name: "Lib")])\n',
      'Sources/Lib/L.swift': 'public struct L {}\n',
    },
    lines: [],
  },
  node: {
    files: { 'package.json': '{"name":"n","version":"1.0.0"}\n', 'index.js': 'x = 1;\n' },
    lines: [],
  },
};

let root: string;
const dirs: Record<string, string> = {};

function writeRepo(dir: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  // The canonical walker memoizes per process; a repo that changes mid-test
  // (the update scenarios) must be re-walked, as a fresh CLI run would.
  clearWalkPathsCache();
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-build-host-'));
  for (const [name, { files }] of Object.entries(MATRIX)) {
    dirs[name] = path.join(root, name);
    writeRepo(dirs[name], files);
  }
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function configFor(dir: string): ResolvedConfig {
  return { ...detect(dir), coverageThreshold: '80', claudeCode: true };
}

describe('repoBuildsElsewhere: what dxkit detects per stack', () => {
  for (const [name, { lines }] of Object.entries(MATRIX)) {
    it(`${name} → ${lines.length ? lines.join('; ') : 'builds in the Linux container'}`, () => {
      expect(buildElsewhereLines(repoBuildsElsewhere(dirs[name]))).toEqual(lines);
    });
  }

  it('a Unity project with no csproj activates the C# pack (it used to read as no language)', () => {
    expect(detectActiveLanguages(dirs.unity).map((p) => p.id)).toEqual(['csharp']);
  });

  it('the C# floor DISCLOSES the shapes dxkit cannot build itself (never a silent pass)', () => {
    for (const name of ['netfx-classic', 'unity', 'unity-committed-csproj']) {
      const cwd = dirs[name];
      const ctx = { cwd, changedFiles: [], scope: 'full' as const };
      const build = csharp.correctness.syntaxCheck(ctx as never);
      expect(build?.cannotStart, name).toMatch(/declare it as a custom check/);
      expect(csharp.correctness.affectedTests(ctx as never), name).toBeNull();
      expect(csharp.lintGate!.lintCommand({ cwd, changedFiles: [] }), name).toBeNull();
      expect(csharp.correctness.execution(cwd).buildTarget).toBe('configured');
    }
    // A Windows SDK-style project keeps its dotnet floor (it runs on the
    // windows host job).
    const ctx = { cwd: dirs.winforms, changedFiles: [], scope: 'full' as const };
    const build = csharp.correctness.syntaxCheck(ctx as never);
    expect(build?.bin).toBe('dotnet');
    expect(build?.cannotStart).toBeUndefined();
  });

  it('a Unity sample nested beside a portable solution does not hide the portable build', () => {
    const dir = path.join(root, 'portable-with-unity-sample');
    writeRepo(dir, {
      'App.sln': 'Microsoft Visual Studio Solution File, Format Version 12.00\n',
      'src/Api/Api.csproj': sdkProject('<TargetFramework>net8.0</TargetFramework>'),
      ...Object.fromEntries(Object.entries(UNITY).map(([k, v]) => [`samples/game/${k}`, v])),
      'samples/game/Assembly-CSharp.csproj': CLASSIC_CSPROJ,
    });
    expect(repoBuildsElsewhere(dir)).toEqual([]);
    expect(csharp.correctness.execution(dir).toolchains).toEqual(['dotnet-sdk']);
  });
});

describe('describeBuildMachine / buildCannotRunOn', () => {
  it('phrases the machine from hosts + registry display names', () => {
    expect(
      describeBuildMachine({
        hosts: ['macos'],
        toolchains: ['xcode'],
        needsBuild: true,
        buildTarget: 'configured',
        weight: 'build',
      }),
    ).toBe('macOS with Xcode');
    expect(
      describeBuildMachine({
        hosts: ['any'],
        toolchains: [],
        needsBuild: false,
        buildTarget: 'none',
        weight: 'cheap',
      }),
    ).toBe('a machine');
  });

  it('treats a toolchain installable on the host as provisionable, and only those', () => {
    const req = {
      hosts: ['any'] as const,
      toolchains: ['dotnet-sdk'] as const,
      needsBuild: true,
      buildTarget: 'discovered' as const,
      weight: 'build' as const,
    };
    expect(buildCannotRunOn(req, 'linux')).toBeNull();
    expect(toolchainInstallableOn('xcode', 'linux')).toBe(false);
    expect(toolchainInstallableOn('netfx-msbuild', 'windows')).toBe(true);
    expect(buildCannotRunOn({ ...req, toolchains: ['unity-editor'] }, 'windows')?.kind).toBe(
      'missing-toolchain',
    );
  });
});

describe('parity: devcontainer.json, AGENTS.md and the gates read one answer', () => {
  // The gates' view on Linux with every INSTALLABLE toolchain present: a build
  // the runner would still refuse here is exactly a build the generated
  // surfaces must send elsewhere, and vice versa.
  const linuxProvisioned: ExecutionEnvironment = {
    host: 'linux',
    hasToolchain: (id) => toolchainInstallableOn(id, 'linux'),
  };

  for (const [name, { lines }] of Object.entries(MATRIX)) {
    it(name, async () => {
      const src = dirs[name];
      const work = path.join(root, `${name}--render`);
      fs.cpSync(src, work, { recursive: true });
      try {
        // 1. The generated devcontainer.json.
        installDevcontainer(work);
        const dc = fs.readFileSync(path.join(work, '.devcontainer', 'devcontainer.json'), 'utf8');
        for (const l of lines) expect(dc).toContain(`//   ${l}`);
        expect(dc.includes('It cannot\n  // build or test this project')).toBe(lines.length > 0);
        expect(dc).not.toContain('__DXKIT_DEVCONTAINER_BUILD_HOST__');

        // 2. The generated AGENTS.md.
        await generate(work, configFor(work), 'dx-only', false, true, true);
        const agents = fs.readFileSync(path.join(work, 'AGENTS.md'), 'utf8');
        for (const l of lines) expect(agents).toContain(`- ${l}`);
        expect(agents.includes('## Where this project builds')).toBe(lines.length > 0);

        // 3. The gates: the runner predicate on a provisioned Linux box, and
        //    placement's host jobs.
        const caps = collectExecutionRequirements(work, detectActiveLanguages(work));
        const refused = new Set(
          caps
            .filter((c) => c.capability === 'correctness')
            .filter((c) => unmetRequirement(c.requirement, linuxProvisioned) !== null)
            .map((c) => c.pack),
        );
        const elsewhere = repoBuildsElsewhere(work);
        expect(new Set(elsewhere.map((e) => e.pack))).toEqual(refused);
        const placedOff = new Set(
          repoPlacementPlan(work).hostJobs.flatMap((j) =>
            j.capabilities.filter((c) => c.capability === 'correctness').map((c) => c.pack),
          ),
        );
        for (const p of placedOff) expect(refused.has(p), `${p} placed off Linux`).toBe(true);
        for (const e of elsewhere) {
          // Not placed on another host ⇒ refused for a toolchain Linux cannot get.
          if (!placedOff.has(e.pack)) expect(e.unmet.kind).toBe('missing-toolchain');
        }

        // 4. No toolchain feature for a pack that cannot build in the container.
        const features = Object.keys(buildDevcontainerFeatures(detect(work).languages, work));
        if (refused.has('csharp')) {
          expect(features).not.toContain('ghcr.io/devcontainers/features/dotnet:2');
        } else if (detect(work).languages.csharp) {
          expect(features).toContain('ghcr.io/devcontainers/features/dotnet:2');
        }

        // 5. `tools install` never provisions the .NET SDK through a
        //    build-bound tool where the C# build cannot run.
        if (hostOf() === 'linux' && detect(work).languages.csharp) {
          const status = findTool(TOOL_DEFS['dotnet-format'], work, { skipVersion: true });
          expect(status.source === 'n/a').toBe(refused.has('csharp'));
          if (refused.has('csharp')) {
            expect(status.notApplicableReason).toMatch(/^the C# build runs on /);
          }
        }
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
      }
    });
  }
});

describe('regeneration (update) refreshes the statement without clobbering user files', () => {
  it('AGENTS.md gains the block when the stack changes, unless the user edited it', async () => {
    const work = path.join(root, 'update-agents');
    writeRepo(work, MATRIX.node.files);
    try {
      await generate(work, configFor(work), 'dx-only', false, true, true);
      const agentsPath = path.join(work, 'AGENTS.md');
      expect(fs.readFileSync(agentsPath, 'utf8')).not.toContain('## Where this project builds');

      // The repo gains a Windows-only C# project; an unmodified AGENTS.md is
      // dxkit-owned and refreshed.
      writeRepo(work, MATRIX.winforms.files);
      await generate(work, configFor(work), 'dx-only', false, true, true);
      expect(fs.readFileSync(agentsPath, 'utf8')).toContain(`- ${WINDOWS_SDK}`);

      // The user edits it; a later stack change never overwrites their file.
      fs.appendFileSync(agentsPath, '\nOwner note.\n');
      writeRepo(work, MATRIX['netfx-classic'].files);
      await generate(work, configFor(work), 'dx-only', false, true, true);
      const after = fs.readFileSync(agentsPath, 'utf8');
      expect(after).toContain('Owner note.');
      expect(after).not.toContain(NETFX);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  it('a dxkit-owned devcontainer.json refreshes under --force; a user-owned one never does', () => {
    const work = path.join(root, 'update-dc');
    writeRepo(work, MATRIX.node.files);
    try {
      installDevcontainer(work);
      const dcPath = path.join(work, '.devcontainer', 'devcontainer.json');
      writeRepo(work, MATRIX['ios-xcodeproj'].files);
      // Without --force the refreshed file lands in the reference sidecar.
      installDevcontainer(work);
      expect(fs.readFileSync(dcPath, 'utf8')).not.toContain(XCODE);
      expect(
        fs.readFileSync(
          path.join(work, '.devcontainer', '.dxkit-reference', 'devcontainer.json'),
          'utf8',
        ),
      ).toContain(XCODE);
      installDevcontainer(work, { force: true });
      expect(fs.readFileSync(dcPath, 'utf8')).toContain(XCODE);

      fs.writeFileSync(dcPath, '{ "name": "my own container" }\n');
      installDevcontainer(work, { force: true });
      expect(fs.readFileSync(dcPath, 'utf8')).toBe('{ "name": "my own container" }\n');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  });
});
