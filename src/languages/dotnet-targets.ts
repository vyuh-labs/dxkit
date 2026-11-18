/**
 * What a .NET repo TARGETS, read once from its project files: the target
 * frameworks (SDK-style `<TargetFramework(s)>` and old-style
 * `<TargetFrameworkVersion>`), the app model where the project file makes it
 * evident (ASP.NET, ASP.NET Core, Windows Forms, WPF), test-project status and
 * the `<Description>`. One parse, three csharp-pack consumers (Rule 2):
 *   - `dotnetSdkVersion`  → `detectVersion` (the SDK CI / the devcontainer
 *     provision: the highest modern `netX.Y` any project targets);
 *   - `describeDotnetTarget` → `describeTarget` (the AGENTS.md heading:
 *     `.NET Framework 4.8 (ASP.NET)`, never a C# language version);
 *   - `dotnetDescription` → `detectDescription`.
 *
 * Read-only and fail-soft: an unreadable or unparseable project contributes
 * nothing, and a value dxkit cannot name (an MSBuild `$(Property)`, an
 * unknown TFM) is left out rather than guessed.
 */
import * as path from 'path';
import { walkPaths } from '../analyzers/tools/walk-paths';
import { readRepoFile } from './version-detect';

export interface DotnetProject {
  /** Repo-relative POSIX path of the `.csproj`. */
  readonly path: string;
  /** Runtime names this project targets (`.NET 8`, `.NET Framework 4.8`). */
  readonly runtimes: readonly string[];
  /** Modern `netX.Y` versions (X >= 5) it targets, for SDK provisioning. */
  readonly modernVersions: readonly string[];
  /** App model evident from the project file, if any. */
  readonly appModel?: string;
  readonly isTest: boolean;
  readonly description?: string;
}

/** A test project by its own declaration (the csharp pack's floor reads this). */
export function isDotnetTestProjectContent(raw: string): boolean {
  return /Microsoft\.NET\.Test\.Sdk|<IsTestProject>\s*true|\b(xunit|nunit|MSTest)\b/i.test(raw);
}

/** `net8.0` → `.NET 8`; `net48` → `.NET Framework 4.8`; unknown → undefined. */
export function dotnetRuntimeForTfm(tfm: string): string | undefined {
  const t = tfm.trim().toLowerCase();
  let m = t.match(/^net(\d+)\.(\d+)(?:-([a-z]+)[\d.]*)?$/);
  if (m && Number(m[1]) >= 5) {
    const ver = m[2] === '0' ? m[1] : `${m[1]}.${m[2]}`;
    const os = m[3] === 'windows' ? ' for Windows' : '';
    return `.NET ${ver}${os}`;
  }
  m = t.match(/^net([1-4])(\d)(\d)?$/);
  if (m) return `.NET Framework ${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ''}`;
  m = t.match(/^netcoreapp(\d+\.\d+)$/);
  if (m) return `.NET Core ${m[1]}`;
  m = t.match(/^netstandard(\d+\.\d+)$/);
  if (m) return `.NET Standard ${m[1]}`;
  return undefined;
}

/** A commented-out element is not a declaration (`<!-- <TargetFramework>net10.0… -->`). */
function stripXmlComments(raw: string): string {
  return raw.replace(/<!--[\s\S]*?-->/g, '');
}

function tagValues(raw: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'gi');
  for (const m of raw.matchAll(re)) out.push(m[1].trim());
  return out;
}

/** Target frameworks a project file (or a Directory.Build.props) declares. */
function declaredTfms(raw: string): string[] {
  const tfms: string[] = [];
  for (const v of [...tagValues(raw, 'TargetFramework'), ...tagValues(raw, 'TargetFrameworks')]) {
    for (const t of v.split(';')) if (t.trim() && !t.includes('$(')) tfms.push(t.trim());
  }
  // Old-style (non-SDK) projects: `<TargetFrameworkVersion>v4.8</...>`.
  for (const v of tagValues(raw, 'TargetFrameworkVersion')) {
    const m = v.match(/^v?([1-4])\.(\d)(?:\.(\d))?$/);
    if (m) tfms.push(`net${m[1]}${m[2]}${m[3] ?? ''}`);
  }
  return tfms;
}

/** The app model a project file makes evident, or undefined. */
function appModelOf(raw: string): string | undefined {
  if (/<Project\s[^>]*Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/i.test(raw)) return 'ASP.NET Core';
  // Old-style web application project: the WAP project-type GUID or the
  // WebApplication targets import that every such project carries.
  if (
    /349c5851-65df-11da-9384-00065b846f21/i.test(raw) ||
    /Microsoft\.WebApplication\.targets/i.test(raw)
  ) {
    return 'ASP.NET';
  }
  if (/<UseWPF>\s*true/i.test(raw) || /60dc8134-eba5-43b8-bcc9-bb4bc16c2548/i.test(raw)) {
    return 'WPF';
  }
  if (
    /<UseWindowsForms>\s*true/i.test(raw) ||
    (/<OutputType>\s*WinExe/i.test(raw) &&
      /<Reference\s+Include="System\.Windows\.Forms"/i.test(raw))
  ) {
    return 'Windows Forms';
  }
  return undefined;
}

/** Every `.csproj` in the repo, parsed. Depth-unlimited (G_v4_12). */
export function readDotnetProjects(cwd: string): DotnetProject[] {
  const projects = walkPaths(cwd, { extensions: ['.csproj'] });
  if (projects.length === 0) return [];
  // Central TFM declarations: a project without its own TFM inherits the
  // nearest Directory.Build.props above it.
  const props = walkPaths(cwd, { extensions: [], basenames: ['Directory.Build.props'] })
    .map((p) => ({
      dir: path.posix.dirname(p),
      tfms: declaredTfms(stripXmlComments(readRepoFile(cwd, p))),
    }))
    .filter((p) => p.tfms.length > 0)
    .sort((a, b) => b.dir.length - a.dir.length);
  const out: DotnetProject[] = [];
  for (const rel of projects) {
    const raw = stripXmlComments(readRepoFile(cwd, rel));
    if (!raw) continue;
    let tfms = declaredTfms(raw);
    if (tfms.length === 0) {
      const dir = path.posix.dirname(rel);
      const inherited = props.find(
        (p) => p.dir === '.' || dir === p.dir || dir.startsWith(`${p.dir}/`),
      );
      if (inherited) tfms = inherited.tfms;
    }
    const runtimes = [...new Set(tfms.map(dotnetRuntimeForTfm).filter((r): r is string => !!r))];
    const modernVersions = tfms
      .map((t) => t.toLowerCase().match(/^net(\d+\.\d+)/)?.[1])
      .filter((v): v is string => !!v && Number(v.split('.')[0]) >= 5);
    const description = tagValues(raw, 'Description').find((d) => d !== '' && !d.includes('$('));
    out.push({
      path: rel,
      runtimes,
      modernVersions,
      appModel: appModelOf(raw),
      isTest: isDotnetTestProjectContent(raw),
      ...(description ? { description } : {}),
    });
  }
  return out;
}

function compareVersions(a: string, b: string): number {
  const [am, an] = a.split('.').map(Number);
  const [bm, bn] = b.split('.').map(Number);
  return am - bm || an - bn;
}

/** The highest modern .NET version any project targets (`'8.0'`), or undefined. */
export function dotnetSdkVersion(projects: readonly DotnetProject[]): string | undefined {
  const all = projects.flatMap((p) => p.modernVersions).sort(compareVersions);
  return all.length ? all[all.length - 1] : undefined;
}

/** Production projects when the repo has any, else every project. */
function productProjects(projects: readonly DotnetProject[]): readonly DotnetProject[] {
  const prod = projects.filter((p) => !p.isTest);
  return prod.length ? prod : projects;
}

/**
 * The AGENTS.md heading for a .NET repo: `C# on .NET Framework 4.8 (ASP.NET)`,
 * `C# on .NET 8 and .NET Standard 2.0 (ASP.NET Core)`. Undefined when no
 * project states a target dxkit can name.
 */
export function describeDotnetTarget(projects: readonly DotnetProject[]): string | undefined {
  const prod = productProjects(projects);
  const runtimes = [...new Set(prod.flatMap((p) => p.runtimes))].sort();
  if (runtimes.length === 0) return undefined;
  const models = [...new Set(prod.map((p) => p.appModel).filter((m): m is string => !!m))].sort();
  const on =
    runtimes.length === 1
      ? runtimes[0]
      : `${runtimes.slice(0, -1).join(', ')} and ${runtimes[runtimes.length - 1]}`;
  return `C# on ${on}${models.length ? ` (${models.join(', ')})` : ''}`;
}

/** The one `<Description>` the production projects state, or undefined when
 *  none or several different ones (precision-first: no guessing which). */
export function dotnetDescription(projects: readonly DotnetProject[]): string | undefined {
  const ds = [
    ...new Set(
      productProjects(projects)
        .map((p) => p.description)
        .filter((d): d is string => !!d),
    ),
  ];
  return ds.length === 1 ? ds[0] : undefined;
}
