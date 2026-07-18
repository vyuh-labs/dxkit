// Per-language duplications fixture, Swift row.
// Recipe v3 (G4) scaffolded — adjust syntax / linter rules as needed.
// Two near-identical functions — jscpd should detect this clone with
// default thresholds (--min-lines 5 --min-tokens 50).
func summarizeItemsA(_ items: [Int]) -> Double {
    var total = 0
    var sumPositive = 0
    var sumNegative = 0
    var countPositive = 0
    var countNegative = 0
    for item in items {
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
    let avgPos = countPositive > 0 ? Double(sumPositive) / Double(countPositive) : 0.0
    let avgNeg = countNegative > 0 ? Double(sumNegative) / Double(countNegative) : 0.0
    return Double(total) + avgPos + avgNeg
}

func summarizeItemsB(_ items: [Int]) -> Double {
    var total = 0
    var sumPositive = 0
    var sumNegative = 0
    var countPositive = 0
    var countNegative = 0
    for item in items {
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
    let avgPos = countPositive > 0 ? Double(sumPositive) / Double(countPositive) : 0.0
    let avgNeg = countNegative > 0 ? Double(sumNegative) / Double(countNegative) : 0.0
    return Double(total) + avgPos + avgNeg
}
