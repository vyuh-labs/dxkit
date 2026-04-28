// Phase 10i.0.2 — per-language lint fixture, Kotlin row.
//
// Multiple deliberate detekt violations so at least one fires under
// detekt's default ruleset across version drift:
//   - WildcardImport: `import com.example.*`
//   - EmptyFunctionBlock: `fun unused() { }`
//   - MagicNumber: literal 42 inline (default-disabled in some
//     versions but harmless if it doesn't fire)
//
// The kotlin pack's lint capability invokes detekt with `--input .`
// and reports the resulting Checkstyle XML's `<error severity=...>`
// counts via `parseDetektCheckstyleXml`. Asserts dxkit's quality
// pipeline reports `metrics.lintTool === 'detekt'` and a non-zero
// (errors + warnings) total.

import java.util.* // detekt: WildcardImport

class BadLint {
    fun unused() { } // detekt: EmptyFunctionBlock

    fun magic(): Int {
        return 42 * 2 // detekt: MagicNumber (when enabled)
    }
}
