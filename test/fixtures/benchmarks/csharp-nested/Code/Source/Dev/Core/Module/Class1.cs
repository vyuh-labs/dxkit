namespace Dxkit.Benchmark.Nested;

// TODO: dpl-studio sentinel — D030 hygiene grep should surface this from
// the fixture root via allSourceExtensions(); pre-D030 this line was
// invisible because '*.cs' wasn't in the include list.
// FIXME: regression marker for sub-branch #1 (sprint-a-rest); a 0 count
// from gatherHygieneMarkers() against this fixture means the registry-
// driven extension derivation regressed.
// HACK: third hygiene-marker variant — keeps the test asserting all three
// tier counts non-zero rather than just TODO.
public class Class1
{
    public string Hello() => "world";
}
