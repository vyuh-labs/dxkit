/**
 * Tests for src/dashboard/graph-tab.ts — the iframe-srcdoc embed of
 * graphify's `graph.html` viewer. Sprint 3 pivot (2026-05-27):
 * dropped the custom cytoscape state machine in favor of reusing the
 * upstream viz.
 *
 * Coverage:
 *   - empty-state branches: no graph.json, graph.html missing,
 *     vis-network bundle missing, graph.html unreadable
 *   - populated rendering: iframe with srcdoc present, vis-network
 *     inlined offline-friendly, navBadge reflects community count
 *   - the pure CDN-swap helper `inlineVisNetwork` + srcdoc encoder
 *     are unit-tested separately (no I/O)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GRAPH_TAB_CSS,
  encodeForSrcdoc,
  injectAggregateBanner,
  inlineVisNetwork,
  renderGraphTab,
} from '../../src/dashboard/graph-tab';
import { GRAPH_REPORT_PATH } from '../../src/explore/types';

/** Minimal valid graph.json wire payload — one community, two symbols. */
function minimalGraphJson(): unknown {
  return {
    schemaVersion: 1,
    meta: {
      tool: 'graphify',
      graphifyVersion: '0.5.0',
      dxkitVersion: '2.7.0',
      generatedAt: '2026-05-27T00:00:00Z',
      sourceFilesInGraph: 1,
      excludedFileCount: 0,
      packs: ['typescript'],
      truncated: false,
      truncatedReason: '',
    },
    nodes: [
      { id: 'n0', kind: 'module', label: 'src/a.ts', sourceFile: 'src/a.ts' },
      { id: 'n1', kind: 'function', label: 'main()', sourceFile: 'src/a.ts', line: 1 },
    ],
    edges: [{ from: 'n0', to: 'n1', relation: 'method' }],
    communities: [
      {
        id: 0,
        nodeIds: ['n0', 'n1'],
        cohesion: 0.9,
        dominantSourceDir: 'src/',
        dominantPack: 'typescript',
      },
    ],
    symbolIndex: { main: ['n1'] },
  };
}

const SAMPLE_GRAPH_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>graphify - sample</title>
<script src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
<style>body{background:#000}</style>
</head>
<body>
<div id="net"></div>
<script>
const RAW_NODES = [{id:"n0",label:"a"}];
const RAW_EDGES = [];
</script>
</body>
</html>`;

/** Stand up a project tmpdir containing graph.json (+ optional graph.html). */
function makeProjectDir(opts: { withGraphJson?: boolean; withGraphHtml?: boolean }): {
  cwd: string;
  cleanup: () => void;
} {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-graph-tab-test-'));
  if (opts.withGraphJson) {
    const reportDir = path.join(cwd, path.dirname(GRAPH_REPORT_PATH));
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(cwd, GRAPH_REPORT_PATH), JSON.stringify(minimalGraphJson()));
  }
  if (opts.withGraphHtml) {
    const reportDir = path.join(cwd, '.dxkit', 'reports');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'graph.html'), SAMPLE_GRAPH_HTML);
  }
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

/** Tmpdir containing a fake vis-network.min.js the renderer will inline. */
function makeFakeVendor(content = '/* fake vis-network UMD */ window.vis = {};'): {
  vendorDir: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-vendor-test-'));
  fs.writeFileSync(path.join(dir, 'vis-network.min.js'), content);
  return { vendorDir: dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('inlineVisNetwork', () => {
  it("replaces graphify's unpkg.com vis-network script with an inline bundle", () => {
    const out = inlineVisNetwork(SAMPLE_GRAPH_HTML, '/* bundled */');
    expect(out).not.toContain('https://unpkg.com');
    expect(out).toContain('<script>/* bundled */</script>');
  });

  it("escapes </script> inside the bundle so it can't prematurely close the inline script", () => {
    const adversarial = "console.log('</script>')"; // slop-ok: string fixture, not a real log call
    const out = inlineVisNetwork(SAMPLE_GRAPH_HTML, adversarial);
    expect(out).toContain('<\\/script>');
    expect(out).not.toContain("'</script>')");
  });

  it('returns upstream HTML unchanged when no vis-network CDN tag is present', () => {
    const upstream = '<html><body>no script</body></html>';
    expect(inlineVisNetwork(upstream, '/* bundled */')).toBe(upstream);
  });

  it('preserves $1/$&/$` literally — does not let String.replace eat backreferences', () => {
    // vis-network's minified UMD contains `"$1"` (a regex capture-group
    // reference inside a string literal). A bare-string replacement
    // argument silently turns `$1` into the first capture-group match,
    // which corrupts the bundle invisibly.
    const adversarial = 'var x = "$1"; var y = "$&"; var z = "$`";';
    const out = inlineVisNetwork(SAMPLE_GRAPH_HTML, adversarial);
    expect(out).toContain('"$1"');
    expect(out).toContain('"$&"');
    expect(out).toContain('"$`"');
  });

  it('matches alternate src formats (single quotes, version pin, path variations)', () => {
    const variants = [
      "<script src='https://unpkg.com/vis-network@9/standalone/umd/vis-network.min.js'></script>",
      '<script defer src="https://cdn.example.com/vis-network/dist/vis-network.min.js"></script>',
    ];
    for (const v of variants) {
      const out = inlineVisNetwork(v, '/* bundled */');
      expect(out).toContain('/* bundled */');
      expect(out).not.toContain('vis-network.min.js"');
    }
  });
});

describe('encodeForSrcdoc', () => {
  it('escapes &, ", and < so the payload can sit inside srcdoc="…"', () => {
    expect(encodeForSrcdoc('<script>')).toBe('&lt;script>');
    expect(encodeForSrcdoc('a&b"c<d')).toBe('a&amp;b&quot;c&lt;d');
  });

  it("leaves > and ' alone — they don't break the attribute", () => {
    expect(encodeForSrcdoc("a > b 'c'")).toBe("a > b 'c'");
  });

  it('is round-trip-friendly when the host decodes via DOM attribute parsing', () => {
    // Browsers decode &amp; → & and &lt; → <. Verifying that nothing
    // double-encodes (`&` doesn't become `&amp;amp;` etc).
    const input = '<div>&nbsp;</div>';
    expect(encodeForSrcdoc(input)).toBe('&lt;div>&amp;nbsp;&lt;/div>');
  });
});

// ─── Empty-state behavior ────────────────────────────────────────────────────

describe('renderGraphTab — empty states', () => {
  it('returns the no-graph empty state when cwd is undefined', () => {
    const result = renderGraphTab({});
    expect(result.hasData).toBe(false);
    expect(result.navBadge).toBe('—');
    expect(result.html).toContain('No graph data found');
    expect(result.html).toContain('style="display:none"');
  });

  it('returns the no-graph empty state when graph.json is missing under cwd', () => {
    const project = makeProjectDir({});
    try {
      const result = renderGraphTab({ cwd: project.cwd });
      expect(result.hasData).toBe(false);
      expect(result.html).toContain('No graph data found');
    } finally {
      project.cleanup();
    }
  });

  it('returns the viewer-skipped state when graph.json exists but graph.html does not', () => {
    const project = makeProjectDir({ withGraphJson: true });
    const vendor = makeFakeVendor();
    try {
      const result = renderGraphTab({ cwd: project.cwd, vendorDir: vendor.vendorDir });
      expect(result.hasData).toBe(false);
      expect(result.navBadge).toBe('1');
      expect(result.html).toContain('Interactive viewer skipped');
      expect(result.html).toContain('5000-node');
    } finally {
      project.cleanup();
      vendor.cleanup();
    }
  });

  it('returns the vendor-missing state when the bundle is absent', () => {
    const project = makeProjectDir({ withGraphJson: true, withGraphHtml: true });
    const emptyVendor = fs.mkdtempSync(path.join(os.tmpdir(), 'dxkit-empty-vendor-'));
    try {
      const result = renderGraphTab({ cwd: project.cwd, vendorDir: emptyVendor });
      expect(result.hasData).toBe(false);
      expect(result.html).toContain('vis-network bundle missing');
    } finally {
      project.cleanup();
      fs.rmSync(emptyVendor, { recursive: true, force: true });
    }
  });
});

// ─── Populated rendering ─────────────────────────────────────────────────────

describe('renderGraphTab — populated', () => {
  let project: ReturnType<typeof makeProjectDir>;
  let vendor: ReturnType<typeof makeFakeVendor>;

  beforeEach(() => {
    project = makeProjectDir({ withGraphJson: true, withGraphHtml: true });
    vendor = makeFakeVendor('window.__VIS_BUNDLE_SENTINEL__ = true;');
  });

  afterEach(() => {
    project.cleanup();
    vendor.cleanup();
  });

  it('reports hasData=true and a numeric badge matching the community count', () => {
    const result = renderGraphTab({ cwd: project.cwd, vendorDir: vendor.vendorDir });
    expect(result.hasData).toBe(true);
    expect(result.navBadge).toBe('1');
  });

  it('embeds the viewer inside an iframe with srcdoc + tight sandboxing', () => {
    const result = renderGraphTab({ cwd: project.cwd, vendorDir: vendor.vendorDir });
    expect(result.html).toContain('<iframe');
    expect(result.html).toContain('srcdoc=');
    expect(result.html).toContain('sandbox="allow-scripts allow-same-origin"');
  });

  it('inlines the local vis-network bundle and removes the unpkg CDN tag', () => {
    const result = renderGraphTab({ cwd: project.cwd, vendorDir: vendor.vendorDir });
    // srcdoc encodes `<` as &lt;, so the inlined `<script>` becomes
    // `&lt;script>` inside the attribute value.
    expect(result.html).toContain('window.__VIS_BUNDLE_SENTINEL__');
    expect(result.html).not.toContain('https://unpkg.com');
  });

  it('starts the tab pane hidden so the activate JS controls visibility', () => {
    const result = renderGraphTab({ cwd: project.cwd, vendorDir: vendor.vendorDir });
    expect(result.html).toContain('style="display:none"');
  });

  it('honors graphHtmlPath override for fixture-driven tests', () => {
    const tmpHtml = path.join(project.cwd, 'fixture.html');
    fs.writeFileSync(tmpHtml, SAMPLE_GRAPH_HTML.replace('graphify - sample', 'override-fixture'));
    const result = renderGraphTab({
      cwd: project.cwd,
      vendorDir: vendor.vendorDir,
      graphHtmlPath: tmpHtml,
    });
    expect(result.hasData).toBe(true);
    expect(result.html).toContain('override-fixture');
  });
});

describe('injectAggregateBanner', () => {
  const meta = {
    mode: 'aggregated' as const,
    totalNodes: 121174,
    totalEdges: 336382,
    communities: 1080,
    aggregatedNodeCount: 1080,
  };

  it('prepends a banner immediately after the <body> tag', () => {
    const html = '<html><body class="g"><div>content</div></body></html>';
    const out = injectAggregateBanner(html, meta);
    const bodyIdx = out.indexOf('<body');
    const bodyClose = out.indexOf('>', bodyIdx);
    expect(out.slice(bodyClose + 1, bodyClose + 60)).toContain('dxkit-aggregated-banner');
  });

  it('formats counts with locale-friendly separators for readability', () => {
    const html = '<html><body></body></html>';
    const out = injectAggregateBanner(html, meta);
    expect(out).toContain('121,174 symbols');
    expect(out).toContain('336,382 edges');
    expect(out).toContain('1,080 communities');
  });

  it('mentions the explore CLI as the drill-down affordance', () => {
    const out = injectAggregateBanner('<html><body></body></html>', meta);
    expect(out).toContain('vyuh-dxkit explore');
  });

  it('returns html unchanged when no <body> tag is present (paranoid fallback)', () => {
    const html = '<not-a-real-doc/>';
    expect(injectAggregateBanner(html, meta)).toBe(html);
  });
});

describe('GRAPH_TAB_CSS', () => {
  it('exposes the tab-pane + empty-state + iframe classes used by the host dashboard', () => {
    expect(GRAPH_TAB_CSS).toContain('.graph-tab-pane');
    expect(GRAPH_TAB_CSS).toContain('.graph-tab-empty');
    expect(GRAPH_TAB_CSS).toContain('.graph-empty-card');
    expect(GRAPH_TAB_CSS).toContain('.graph-iframe');
  });
});
