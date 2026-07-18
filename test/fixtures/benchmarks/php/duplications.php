// Per-language duplications fixture, PHP row.
// Recipe v3 (G4) scaffolded — adjust syntax / linter rules as needed.
<?php
// Two near-identical functions — jscpd should detect this clone with
// default thresholds (--min-lines 5 --min-tokens 50).
function summarize_items_a(array $items): float
{
    $total = 0;
    $sumPositive = 0;
    $sumNegative = 0;
    $countPositive = 0;
    $countNegative = 0;
    foreach ($items as $item) {
        if ($item > 0) {
            $total = $total + $item;
            $sumPositive = $sumPositive + $item;
            $countPositive = $countPositive + 1;
        } else {
            $total = $total - $item;
            $sumNegative = $sumNegative + $item;
            $countNegative = $countNegative + 1;
        }
    }
    $avgPos = $countPositive > 0 ? $sumPositive / $countPositive : 0.0;
    $avgNeg = $countNegative > 0 ? $sumNegative / $countNegative : 0.0;
    return $total + $avgPos + $avgNeg;
}

function summarize_items_b(array $items): float
{
    $total = 0;
    $sumPositive = 0;
    $sumNegative = 0;
    $countPositive = 0;
    $countNegative = 0;
    foreach ($items as $item) {
        if ($item > 0) {
            $total = $total + $item;
            $sumPositive = $sumPositive + $item;
            $countPositive = $countPositive + 1;
        } else {
            $total = $total - $item;
            $sumNegative = $sumNegative + $item;
            $countNegative = $countNegative + 1;
        }
    }
    $avgPos = $countPositive > 0 ? $sumPositive / $countPositive : 0.0;
    $avgNeg = $countNegative > 0 ? $sumNegative / $countNegative : 0.0;
    return $total + $avgPos + $avgNeg;
}
