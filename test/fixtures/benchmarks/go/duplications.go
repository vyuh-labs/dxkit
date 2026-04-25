// Two near-identical helpers — jscpd should detect this clone with
// default thresholds (--min-lines 5 --min-tokens 50). Phase 10i.0.3:
// per-language duplication fixture.
package main

func SummarizeItemsA(items []int) int {
	total := 0
	sumPositive := 0
	sumNegative := 0
	countPositive := 0
	countNegative := 0
	for _, item := range items {
		if item > 0 {
			total = total + item
			sumPositive = sumPositive + item
			countPositive = countPositive + 1
		} else {
			total = total - item
			sumNegative = sumNegative + item
			countNegative = countNegative + 1
		}
	}
	avgPos := 0
	if countPositive > 0 {
		avgPos = sumPositive / countPositive
	}
	avgNeg := 0
	if countNegative > 0 {
		avgNeg = sumNegative / countNegative
	}
	return total + avgPos + avgNeg
}

func SummarizeItemsB(items []int) int {
	total := 0
	sumPositive := 0
	sumNegative := 0
	countPositive := 0
	countNegative := 0
	for _, item := range items {
		if item > 0 {
			total = total + item
			sumPositive = sumPositive + item
			countPositive = countPositive + 1
		} else {
			total = total - item
			sumNegative = sumNegative + item
			countNegative = countNegative + 1
		}
	}
	avgPos := 0
	if countPositive > 0 {
		avgPos = sumPositive / countPositive
	}
	avgNeg := 0
	if countNegative > 0 {
		avgNeg = sumNegative / countNegative
	}
	return total + avgPos + avgNeg
}
