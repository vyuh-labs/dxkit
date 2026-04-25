// Deliberate dotnet-format violation. Phase 10i.0.2: per-language
// lint fixture (multi-project variant). The body uses 3-space
// indentation; .NET defaults to 4 spaces, so `dotnet format
// --verify-no-changes` exits non-zero on this file.
namespace ProjectA;

public static class BadLint
{
   public static int Value => 42;
}
