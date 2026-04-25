// Deliberate dotnet-format violation. Phase 10i.0.2: per-language
// lint fixture. The body uses 3-space indentation; .NET defaults to
// 4 spaces, so `dotnet format --verify-no-changes` exits non-zero
// and reports the file as needing reformatting.
namespace Dxkit.Benchmark;

public static class BadLint
{
   public static int Value => 42;
}
