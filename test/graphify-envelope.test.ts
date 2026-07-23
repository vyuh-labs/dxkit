import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildGraphifyEnvelope } from '../src/analyzers/tools/graphify';
import { translateGraphifyGraph } from '../src/analyzers/tools/graphify-translate';

// Minimal valid GraphifyResult shape — only maxFunctionsFilePath is
// path-bearing; the other fields are numeric counts the envelope
// passes through unchanged.
function syntheticResult(maxFunctionsFilePath: string) {
  return {
    functionCount: 100,
    classCount: 10,
    maxFunctionsInFile: 50,
    maxFunctionsFilePath,
    godNodeCount: 2,
    communityCount: 5,
    avgCohesion: 0.75,
    orphanModuleCount: 3,
    deadImportCount: 1,
    commentedCodeRatio: 0.1,
    sourceFilesInGraph: 200,
  };
}

describe('buildGraphifyEnvelope', () => {
  it('normalizes an absolute maxFunctionsFilePath into a project-relative path', () => {
    const cwd = '/home/anybody/projects/myrepo';
    const abs = path.join(cwd, 'src', 'components', 'big.tsx');
    const env = buildGraphifyEnvelope(syntheticResult(abs), cwd);
    expect(env.maxFunctionsFilePath).toBe('src/components/big.tsx');
    expect(env.maxFunctionsFilePath.startsWith('/')).toBe(false);
  });

  it('passes through an already-relative maxFunctionsFilePath unchanged in shape', () => {
    const cwd = '/home/anybody/projects/myrepo';
    const env = buildGraphifyEnvelope(syntheticResult('src/util.ts'), cwd);
    expect(env.maxFunctionsFilePath).toBe('src/util.ts');
  });

  it('emits an empty string when the translator reports no max-functions file', () => {
    const cwd = '/home/anybody/projects/myrepo';
    const env = buildGraphifyEnvelope(syntheticResult(''), cwd);
    expect(env.maxFunctionsFilePath).toBe('');
  });

  it('strips a username-shaped absolute prefix that would otherwise leak into customer reports', () => {
    // Regression pin for the customer-visible bug: rendered markdown
    // showed `Densest file: /home/<auditor>/projects/.../foo.ts`.
    // The envelope is the single chokepoint that prevents the leak.
    const cwd = '/home/auditor/projects/repos/frontend';
    const abs = '/home/auditor/projects/repos/frontend/public/viewer/assets/index.js';
    const env = buildGraphifyEnvelope(syntheticResult(abs), cwd);
    expect(env.maxFunctionsFilePath).toBe('public/viewer/assets/index.js');
    expect(env.maxFunctionsFilePath.includes('/home/')).toBe(false);
  });

  it('preserves non-path fields verbatim', () => {
    const env = buildGraphifyEnvelope(syntheticResult('src/x.ts'), '/tmp/repo');
    expect(env.functionCount).toBe(100);
    expect(env.classCount).toBe(10);
    expect(env.maxFunctionsInFile).toBe(50);
    expect(env.godNodeCount).toBe(2);
    expect(env.communityCount).toBe(5);
    expect(env.avgCohesion).toBe(0.75);
    expect(env.orphanModuleCount).toBe(3);
    expect(env.deadImportCount).toBe(1);
    expect(env.commentedCodeRatio).toBe(0.1);
    expect(env.tool).toBe('graphify');
    expect(env.schemaVersion).toBe(1);
  });
});

/**
 * Translation contract for graphify's 0.9.x wire dialect. These carry the
 * same concerns the old generated-Python structural tests guarded (code
 * graph, not docs/config; source-extension scoping; exclusions), plus the
 * derivations that moved into TypeScript with the 4.2 driver rewrite:
 * kinds from method edges, pack-declared export detection, edge relation
 * mapping, community regrouping, and the aggregate metrics.
 */
describe('translateGraphifyGraph — graphify 0.9.x dialect', () => {
  let cwd: string;

  beforeAll(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-translate-test-'));
    fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
    fs.mkdirSync(path.join(cwd, 'node_modules', 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(cwd, 'src', 'app.controller.ts'),
      [
        "import { helper } from './util';",
        '',
        'export class AppController {',
        '  root() {',
        '    return helper();',
        '  }',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(cwd, 'src', 'util.ts'),
      ['export function helper() {', '  return 1;', '}', '', 'function internal() {}', ''].join(
        '\n',
      ),
    );
    fs.writeFileSync(path.join(cwd, 'node_modules', 'lib', 'dep.js'), 'module.exports = 1;\n');
    // Genuinely minified shape: one line far above the bytes-per-line floor.
    fs.writeFileSync(path.join(cwd, 'src', 'bundle.min.js'), `var x=1;${'a'.repeat(6000)}\n`);
  });

  afterAll(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function rawFixture() {
    return {
      directed: true,
      nodes: [
        // File nodes — bare basename and path-qualified label shapes.
        {
          id: 'src_app_controller',
          label: 'app.controller.ts',
          file_type: 'code',
          source_file: 'src/app.controller.ts',
          source_location: 'L1',
          community: 0,
        },
        {
          id: 'src_util',
          label: 'src/util.ts',
          file_type: 'code',
          source_file: 'src/util.ts',
          source_location: 'L1',
          community: 1,
        },
        // Symbols.
        {
          id: 'src_app_controller_appcontroller',
          label: 'AppController',
          file_type: 'code',
          source_file: 'src/app.controller.ts',
          source_location: 'L3',
          community: 0,
        },
        {
          id: 'src_app_controller_appcontroller_root',
          label: '.root()',
          file_type: 'code',
          source_file: 'src/app.controller.ts',
          source_location: 'L4',
          community: 0,
        },
        {
          id: 'src_util_helper',
          label: 'helper()',
          file_type: 'code',
          source_file: 'src/util.ts',
          source_location: 'L1',
          community: 1,
        },
        {
          id: 'src_util_internal',
          label: 'internal()',
          file_type: 'code',
          source_file: 'src/util.ts',
          source_location: 'L5',
          community: 1,
        },
        // Noise the code graph must drop: docs, concepts, manifest
        // entries, external stubs, excluded dirs, minified bundles.
        {
          id: 'readme',
          label: 'README.md',
          file_type: 'document',
          source_file: 'README.md',
          source_location: 'L1',
        },
        { id: 'concept_auth', label: 'Authentication', file_type: 'concept' },
        {
          id: 'package_author',
          label: 'package author',
          file_type: 'code',
          source_file: 'package.json',
          source_location: 'L19',
        },
        { id: 'ref_external', label: 'express', file_type: 'code' },
        {
          id: 'nm_dep',
          label: 'dep.js',
          file_type: 'code',
          source_file: 'node_modules/lib/dep.js',
          source_location: 'L1',
        },
        {
          id: 'minified',
          label: 'bundle.min.js',
          file_type: 'code',
          source_file: 'src/bundle.min.js',
          source_location: 'L1',
        },
      ],
      links: [
        {
          source: 'src_app_controller_appcontroller',
          target: 'src_app_controller_appcontroller_root',
          relation: 'method',
        },
        {
          source: 'src_app_controller_appcontroller_root',
          target: 'src_util_helper',
          relation: 'calls',
        },
        { source: 'src_app_controller', target: 'src_util', relation: 'imports' },
        // Relations outside the dxkit schema must be dropped, as must
        // self-loops and edges into dropped nodes.
        {
          source: 'src_app_controller',
          target: 'src_app_controller_appcontroller',
          relation: 'contains',
        },
        { source: 'src_util_helper', target: 'src_util_helper', relation: 'calls' },
        {
          source: 'src_app_controller_appcontroller_root',
          target: 'ref_external',
          relation: 'references',
        },
        { source: 'nm_dep', target: 'src_util_helper', relation: 'calls' },
      ],
    };
  }

  function translated() {
    return translateGraphifyGraph(rawFixture(), cwd, {
      graphifyVersion: '0.9.25',
      dxkitVersion: '4.2.0-test',
    });
  }

  it('keeps only real code nodes: docs, concepts, manifest entries, external stubs, excluded dirs, and minified files drop', () => {
    const { graph } = translated();
    const ids = graph.nodes.map((n) => n.id);
    expect(ids).toContain('src_util_helper');
    for (const dropped of [
      'readme',
      'concept_auth',
      'package_author',
      'ref_external',
      'nm_dep',
      'minified',
    ]) {
      expect(ids).not.toContain(dropped);
    }
  });

  it('preserves graphify deterministic node ids verbatim (run-stable identity)', () => {
    const { graph } = translated();
    expect(graph.nodes.map((n) => n.id)).toContain('src_app_controller_appcontroller_root');
  });

  it('derives kinds from label shape + method edges (file→module, owner→class, member→method, free→function)', () => {
    const { graph } = translated();
    const kind = (id: string) => graph.nodes.find((n) => n.id === id)?.kind;
    expect(kind('src_app_controller')).toBe('module');
    expect(kind('src_util')).toBe('module'); // path-qualified file label
    expect(kind('src_app_controller_appcontroller')).toBe('class');
    expect(kind('src_app_controller_appcontroller_root')).toBe('method');
    expect(kind('src_util_helper')).toBe('function');
  });

  it('detects exported via the pack lineCheck; module nodes carry no exported flag', () => {
    const { graph } = translated();
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    expect(byId.get('src_app_controller_appcontroller')?.exported).toBe(true); // `export class`
    expect(byId.get('src_util_helper')?.exported).toBe(true); // `export function`
    expect(byId.get('src_util_internal')?.exported).toBe(false); // bare `function`
    expect(byId.get('src_app_controller')?.exported).toBeUndefined();
  });

  it('maps relations onto the dxkit schema and drops the rest (plus self-loops and edges into dropped nodes)', () => {
    const { graph } = translated();
    const rels = graph.edges.map((e) => `${e.from}->${e.to}:${e.relation}`);
    expect(rels).toContain(
      'src_app_controller_appcontroller->src_app_controller_appcontroller_root:method',
    );
    expect(rels).toContain('src_app_controller_appcontroller_root->src_util_helper:calls');
    expect(rels).toContain('src_app_controller->src_util:imports_from'); // 'imports' folds in
    expect(graph.edges).toHaveLength(3);
  });

  it('regroups communities from the per-node assignment with cohesion + dominant dir/pack', () => {
    const { graph } = translated();
    expect(graph.communities).toHaveLength(2);
    const c0 = graph.communities.find((c) => c.id === 0)!;
    expect(c0.nodeIds).toContain('src_app_controller_appcontroller');
    expect(c0.dominantSourceDir).toBe('src/');
    expect(c0.dominantPack).toBe('typescript');
    expect(c0.cohesion).toBeGreaterThan(0);
    expect(c0.cohesion).toBeLessThanOrEqual(1);
  });

  it('builds the lowercased symbol index with paren/owner prefixes stripped', () => {
    const { graph } = translated();
    expect(graph.symbolIndex['root']).toContain('src_app_controller_appcontroller_root');
    expect(graph.symbolIndex['helper']).toContain('src_util_helper');
    expect(graph.symbolIndex['appcontroller']).toContain('src_app_controller_appcontroller');
  });

  it('computes the aggregate metrics from the translated graph', () => {
    const { metrics } = translated();
    expect(metrics.functionCount).toBe(3); // root, helper, internal
    expect(metrics.classCount).toBe(1);
    expect(metrics.communityCount).toBe(2);
    expect(metrics.sourceFilesInGraph).toBe(2);
    expect(metrics.maxFunctionsInFile).toBe(2); // util.ts: helper + internal
    expect(metrics.maxFunctionsFilePath).toBe('src/util.ts');
  });

  it('stamps meta with versions, pack set, and the excluded-file disclosure', () => {
    const { graph } = translated();
    expect(graph.meta.tool).toBe('graphify');
    expect(graph.meta.graphifyVersion).toBe('0.9.25');
    expect(graph.meta.dxkitVersion).toBe('4.2.0-test');
    expect(graph.meta.packs).toEqual(['typescript']);
    expect(graph.meta.excludedFileCount).toBeGreaterThanOrEqual(2); // node_modules + minified
    expect(graph.meta.truncated).toBe(false);
  });

  it('tolerates the "edges" top-level key variant', () => {
    const raw = rawFixture() as { links?: unknown; edges?: unknown };
    raw.edges = raw.links;
    delete raw.links;
    const { graph } = translateGraphifyGraph(raw, cwd, {
      graphifyVersion: '0.9.25',
      dxkitVersion: 'test',
    });
    expect(graph.edges.length).toBe(3);
  });
});
