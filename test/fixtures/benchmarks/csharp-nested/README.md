# csharp-nested benchmark fixture (D024)

Mirrors the shape of `~/projects/external-repos/dpl-studio`: a deep
enterprise .NET layout where the `.csproj` files live under
`Code/Source/Dev/Core/<Module>/<Module>.csproj` — five directory
levels below the repo root.

Prior to D024 (closed in 2.4.7), `csharp.detect()` used a depth-3
recursive walk and reported "Stack: unknown" from the fixture root.
Depth 5 covers this layout without descending into deeply-nested
package directories on a real monorepo.

Used by `test/languages-csharp.test.ts` to guard the depth bump
against regression.
