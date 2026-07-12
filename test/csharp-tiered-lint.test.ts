/**
 * The tiered C# lint capability: Roslyn diagnostics from `dotnet build`
 * output tier through `mapRoslynSeverity`, counted by `countRoslynWarnings`
 * with multi-TFM deduplication. The parse regex itself is pinned by the
 * lint-gate format contract (lint-formats.test.ts); this file pins the
 * severity map and the counting semantics the quality capability adds on
 * top. (The live `dotnet build` path is exercised by the cross-ecosystem
 * CI matrix, which provisions the SDK.)
 */

import { describe, it, expect } from 'vitest';
import { countRoslynWarnings, mapRoslynSeverity } from '../src/languages/csharp';

describe('mapRoslynSeverity', () => {
  it('ranks the security analyzer families high', () => {
    expect(mapRoslynSeverity('CA2100')).toBe('high'); // SQL injection review
    expect(mapRoslynSeverity('CA3001')).toBe('high'); // injection
    expect(mapRoslynSeverity('CA5350')).toBe('high'); // weak crypto
  });

  it('ranks design/usage rules, compiler warnings, and obsoletions medium', () => {
    expect(mapRoslynSeverity('CA1822')).toBe('medium'); // design
    expect(mapRoslynSeverity('CS0618')).toBe('medium'); // obsolete member
    expect(mapRoslynSeverity('CS8602')).toBe('medium'); // possible null deref
    expect(mapRoslynSeverity('SYSLIB0014')).toBe('medium');
  });

  it('ranks style + formatter codes low, and survives junk input', () => {
    expect(mapRoslynSeverity('IDE0055')).toBe('low');
    expect(mapRoslynSeverity('WHITESPACE')).toBe('low');
    expect(mapRoslynSeverity(null)).toBe('low');
    expect(mapRoslynSeverity(undefined)).toBe('low');
    expect(mapRoslynSeverity('')).toBe('low');
  });
});

describe('countRoslynWarnings', () => {
  const BUILD_OUTPUT = [
    '  Determining projects to restore...',
    '  All projects are up-to-date for restore.',
    'Services/UserService.cs(42,13): warning CA2100: Review SQL query for vulnerabilities [/repo/App.csproj]',
    'Controllers/HomeController.cs(12,5): warning CA1822: Member does not access instance data [/repo/App.csproj]',
    'Controllers/HomeController.cs(30,9): warning CS0618: Method is obsolete [/repo/App.csproj]',
    'Program.cs(3,1): warning IDE0055: Fix formatting [/repo/App.csproj]',
    '  App -> /repo/bin/Debug/net8.0/App.dll',
  ].join('\n');

  it('tiers each diagnostic and ignores non-warning lines', () => {
    expect(countRoslynWarnings(BUILD_OUTPUT)).toEqual({
      critical: 0,
      high: 1,
      medium: 2,
      low: 1,
    });
  });

  it('deduplicates multi-TFM re-emissions of the same diagnostic', () => {
    const multiTfm = [
      'A.cs(1,1): warning CA1822: msg [/repo/App.csproj::TargetFramework=net8.0]',
      'A.cs(1,1): warning CA1822: msg [/repo/App.csproj::TargetFramework=net9.0]',
      'A.cs(2,1): warning CA1822: msg [/repo/App.csproj::TargetFramework=net9.0]',
    ].join('\n');
    expect(countRoslynWarnings(multiTfm)).toEqual({ critical: 0, high: 0, medium: 2, low: 0 });
  });

  it('a clean build counts nothing', () => {
    expect(
      countRoslynWarnings('  Determining projects to restore...\n  App -> /repo/bin/App.dll'),
    ).toEqual({ critical: 0, high: 0, medium: 0, low: 0 });
  });
});
