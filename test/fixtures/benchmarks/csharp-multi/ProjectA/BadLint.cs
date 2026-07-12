// Deliberate lint violations for the per-language matrix. The unused local
// is a guaranteed compiler diagnostic (CS0219) — the tiered lint capability
// reads Roslyn warnings from `dotnet build`, so the fixture must carry an
// analyzer-visible defect, not just formatting. The 3-space indentation
// stays for the formatter FALLBACK path (legacy repos the SDK cannot
// build), which `dotnet format --verify-no-changes` still flags.
namespace Dxkit.Benchmark;

public static class BadLint
{
   public static int Value()
   {
      int unused = 1;
      return 42;
   }
}
