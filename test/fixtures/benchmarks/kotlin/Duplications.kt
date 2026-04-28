// Phase 10i.0.3 — per-language duplication fixture, Kotlin row.
//
// Two near-identical helpers — jscpd (language-agnostic) should detect
// this clone with default thresholds (--min-lines 5 --min-tokens 50).
// Bodies are sized comfortably above the 50-token threshold so the
// match is reliable across whitespace differences. Mirrors the python
// duplications fixture layout.

class Duplications {
    fun summarizeItemsA(items: List<Int>): Double {
        var total = 0
        var sumPositive = 0
        var sumNegative = 0
        var countPositive = 0
        var countNegative = 0
        for (item in items) {
            if (item > 0) {
                total = total + item
                sumPositive = sumPositive + item
                countPositive = countPositive + 1
            } else {
                total = total - item
                sumNegative = sumNegative + item
                countNegative = countNegative + 1
            }
        }
        val avgPos = if (countPositive > 0) sumPositive.toDouble() / countPositive else 0.0
        val avgNeg = if (countNegative > 0) sumNegative.toDouble() / countNegative else 0.0
        return total + avgPos + avgNeg
    }

    fun summarizeItemsB(items: List<Int>): Double {
        var total = 0
        var sumPositive = 0
        var sumNegative = 0
        var countPositive = 0
        var countNegative = 0
        for (item in items) {
            if (item > 0) {
                total = total + item
                sumPositive = sumPositive + item
                countPositive = countPositive + 1
            } else {
                total = total - item
                sumNegative = sumNegative + item
                countNegative = countNegative + 1
            }
        }
        val avgPos = if (countPositive > 0) sumPositive.toDouble() / countPositive else 0.0
        val avgNeg = if (countNegative > 0) sumNegative.toDouble() / countNegative else 0.0
        return total + avgPos + avgNeg
    }
}
