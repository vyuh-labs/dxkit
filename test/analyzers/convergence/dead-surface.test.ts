import { describe, it, expect } from 'vitest';
import {
  deadSurfaceTier,
  matchesNonConsumerConvention,
  isSpecificHandlerName,
  type DeadSurfaceSignals,
} from '../../../src/analyzers/convergence/dead-surface';
import { indexGraph } from '../../../src/explore/load';
import { calledSymbolNames } from '../../../src/explore/queries';
import type { GraphJson, GraphNode, GraphEdge } from '../../../src/explore/types';

/**
 * The dead-surface confidence ladder + the direct-call seam query — the pure
 * core of phase 2, pinned independent of any I/O. The ladder must never emit a
 * loud `removable` it can't back up (the precision floor), so the tests assert
 * the bias-to-false-negative boundaries explicitly.
 */

const base: DeadSurfaceSignals = {
  isConventionRoute: false,
  isDirectlyCalled: false,
  crossRepoConsumersVisible: false,
  isStructuralDuplicate: false,
};

describe('deadSurfaceTier — the confidence ladder', () => {
  it('a convention route is always expected (external actor drives it)', () => {
    expect(deadSurfaceTier({ ...base, isConventionRoute: true })).toBe('expected');
    // even if it would otherwise converge to removable
    expect(
      deadSurfaceTier({
        ...base,
        isConventionRoute: true,
        crossRepoConsumersVisible: true,
        isStructuralDuplicate: true,
      }),
    ).toBe('expected');
  });

  it('a direct-called route is expected (consumed, just not over HTTP)', () => {
    expect(deadSurfaceTier({ ...base, isDirectlyCalled: true })).toBe('expected');
  });

  it('removable requires BOTH visible consumers AND a duplicate (convergence)', () => {
    expect(
      deadSurfaceTier({ ...base, crossRepoConsumersVisible: true, isStructuralDuplicate: true }),
    ).toBe('removable');
  });

  it('a duplicate without visible consumers is only likely (deadness unconfirmed)', () => {
    // The cross-repo consumer could exist and be invisible → never shout.
    expect(deadSurfaceTier({ ...base, isStructuralDuplicate: true })).toBe('likely');
  });

  it('visible consumers without a duplicate is only likely (single signal)', () => {
    expect(deadSurfaceTier({ ...base, crossRepoConsumersVisible: true })).toBe('likely');
  });

  it('a bare unconsumed route is likely', () => {
    expect(deadSurfaceTier(base)).toBe('likely');
  });
});

describe('matchesNonConsumerConvention', () => {
  const patterns = ['/webhook', '/cron/', '/healthz', '/cli/'];

  it('matches on the URL path', () => {
    expect(
      matchesNonConsumerConvention('src/app/api/stripe/route.ts', '/webhook/stripe', patterns),
    ).toBe(true);
    expect(matchesNonConsumerConvention('src/x.ts', '/healthz', patterns)).toBe(true);
  });

  it('matches on the file path', () => {
    expect(matchesNonConsumerConvention('src/app/api/cli/teams/route.ts', '/teams', patterns)).toBe(
      true,
    );
  });

  it('does not match an ordinary route', () => {
    expect(matchesNonConsumerConvention('src/app/api/teams/route.ts', '/teams', patterns)).toBe(
      false,
    );
  });

  it('is case-insensitive and empty-safe', () => {
    expect(matchesNonConsumerConvention('X/WEBHOOK/y.ts', '/Y', patterns)).toBe(true);
    expect(matchesNonConsumerConvention('src/x.ts', '/anything', [])).toBe(false);
  });
});

describe('isSpecificHandlerName', () => {
  it('rejects bare HTTP verbs and generic names (bias to false-negative)', () => {
    for (const g of ['GET', 'post', 'PUT', 'handler', 'default', 'index', 'Delete()']) {
      expect(isSpecificHandlerName(g), g).toBe(false);
    }
  });

  it('accepts a specific data-layer symbol', () => {
    expect(isSpecificHandlerName('getDivisions')).toBe(true);
    expect(isSpecificHandlerName('data.getPlayerSeasonAttributes()')).toBe(true);
  });

  it('rejects null / empty', () => {
    expect(isSpecificHandlerName(null)).toBe(false);
    expect(isSpecificHandlerName(undefined)).toBe(false);
    expect(isSpecificHandlerName('')).toBe(false);
  });
});

// ── calledSymbolNames (the direct-call seam query) ──────────────────────────

let idc = 0;
function node(label: string, sourceFile = 'src/x.ts'): GraphNode {
  return { id: `${label}#${idc++}`, kind: 'function', label, sourceFile, line: 1 };
}
function calls(from: GraphNode, to: GraphNode): GraphEdge {
  return { from: from.id, to: to.id, relation: 'calls' };
}
function graphOf(nodes: GraphNode[], edges: GraphEdge[]): GraphJson {
  return {
    schemaVersion: 2,
    meta: {
      tool: 'graphify',
      graphifyVersion: '0',
      dxkitVersion: '0',
      generatedAt: '',
      sourceFilesInGraph: 0,
      excludedFileCount: 0,
      packs: [],
      truncated: false,
      truncatedReason: '',
    },
    nodes,
    edges,
    communities: [],
    symbolIndex: {},
    endpoints: [],
  };
}

describe('calledSymbolNames — direct-call seam', () => {
  it('collects the stripped names of every calls-edge target', () => {
    const page = node('Page', 'src/app/page.tsx');
    const getDivisions = node('getDivisions()', 'src/lib/data.ts');
    const respond = node('data.respond()', 'src/lib/http.ts');
    const g = indexGraph(graphOf([page, getDivisions, respond], [calls(page, getDivisions)]));
    const names = calledSymbolNames(g);
    expect(names.has('getDivisions')).toBe(true);
    // respond is never called → absent
    expect(names.has('respond')).toBe(false);
    expect(names.has('Page')).toBe(false);
  });

  it('strips receiver qualifiers so a member call resolves by symbol', () => {
    const caller = node('Page', 'src/app/page.tsx');
    const target = node('data.getPlayer()', 'src/lib/data.ts');
    const g = indexGraph(graphOf([caller, target], [calls(caller, target)]));
    expect(calledSymbolNames(g).has('getPlayer')).toBe(true);
  });
});
