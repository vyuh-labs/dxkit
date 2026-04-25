// Phase 10i.0.4 — deliberate untested file fixture. No matching
// test file (e.g. UntestedModuleTests.cs) exists; dxkit's
// `test-gaps` filename-match coverage source should report this
// in `gaps[]` with `hasMatchingTest: false`.
namespace Dxkit.Benchmark;

public static class UntestedModule
{
    public static string Describe() => "untested";
}
