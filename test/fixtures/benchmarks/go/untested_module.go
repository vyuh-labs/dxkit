// Phase 10i.0.4 — deliberate untested file fixture. No matching
// `_test.go` file exists; dxkit's `test-gaps` filename-match
// coverage source should report this in `gaps[]` with
// `hasMatchingTest: false`.
package main

func DescribeUntested() string {
	return "untested"
}
