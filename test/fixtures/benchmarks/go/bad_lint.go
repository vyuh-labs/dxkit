// Deliberate gosimple S1002 violation. Phase 10i.0.2: per-language
// lint fixture. golangci-lint's default config enables `gosimple`
// and S1002 ("should omit comparison to bool constant") is not in
// the default exclusion-rules suppression list, so it surfaces
// reliably. We tried errcheck first (os.Setenv ignored return) but
// golangci-lint's default excludes filter common errcheck patterns.
package main

func BadLint() bool {
	x := true
	return x == true //nolint:gocritic // intentional: triggers gosimple S1002
}
