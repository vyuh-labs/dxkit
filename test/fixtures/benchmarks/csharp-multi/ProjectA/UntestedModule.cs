// Phase 10i.0.4 — deliberate untested file fixture (multi-project
// variant). No matching test file exists; dxkit's `test-gaps`
// filename-match coverage source should report this in `gaps[]`
// with `hasMatchingTest: false`.
namespace ProjectA;

public static class UntestedModule
{
    public static string Describe() => "untested";
}
