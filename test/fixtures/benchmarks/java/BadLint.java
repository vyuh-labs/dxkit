// Phase 10k.1.0 — per-language lint fixture, Java row.
//
// Multiple deliberate PMD violations so at least one fires under
// PMD's quickstart ruleset across version drift:
//   - UnusedImports: `import java.util.*;` (wildcard + unused)
//   - EmptyMethodInAbstractClassShouldBeAbstract / EmptyControlStatement:
//     `void unused() {}`
//   - AvoidLiteralsInIfCondition / shorthand-magic numbers in math
//
// The Java pack's lint capability (target: PMD) invokes
// `pmd check -d <fixture> -R rulesets/java/quickstart.xml -f json`
// and reports the resulting JSON `violations[]` count. Asserts
// dxkit's quality pipeline reports `metrics.lintTool === 'pmd'`
// once the lint provider lands in 10k.1.x.

import java.util.*; // PMD: UnusedImports

public class BadLint {
    void unused() {} // PMD: EmptyMethodInAbstractClassShouldBeAbstract / similar

    int magic() {
        return 42 * 2; // PMD: AvoidLiteralsInIfCondition / generic magic-number warns
    }
}
