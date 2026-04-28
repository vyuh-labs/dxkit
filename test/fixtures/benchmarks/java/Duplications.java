// Phase 10k.1.0 — per-language duplication fixture, Java row.
//
// Two near-identical methods — jscpd (language-agnostic) should detect
// this clone with default thresholds (--min-lines 5 --min-tokens 50).
// Bodies are sized comfortably above the 50-token threshold so the
// match is reliable across whitespace differences. Mirrors the
// kotlin/python duplications fixture layout.

public class Duplications {
    public double summarizeItemsA(int[] items) {
        int total = 0;
        int sumPositive = 0;
        int sumNegative = 0;
        int countPositive = 0;
        int countNegative = 0;
        for (int item : items) {
            if (item > 0) {
                total = total + item;
                sumPositive = sumPositive + item;
                countPositive = countPositive + 1;
            } else {
                total = total - item;
                sumNegative = sumNegative + item;
                countNegative = countNegative + 1;
            }
        }
        double avgPos = countPositive > 0 ? (double) sumPositive / countPositive : 0.0;
        double avgNeg = countNegative > 0 ? (double) sumNegative / countNegative : 0.0;
        return total + avgPos + avgNeg;
    }

    public double summarizeItemsB(int[] items) {
        int total = 0;
        int sumPositive = 0;
        int sumNegative = 0;
        int countPositive = 0;
        int countNegative = 0;
        for (int item : items) {
            if (item > 0) {
                total = total + item;
                sumPositive = sumPositive + item;
                countPositive = countPositive + 1;
            } else {
                total = total - item;
                sumNegative = sumNegative + item;
                countNegative = countNegative + 1;
            }
        }
        double avgPos = countPositive > 0 ? (double) sumPositive / countPositive : 0.0;
        double avgNeg = countNegative > 0 ? (double) sumNegative / countNegative : 0.0;
        return total + avgPos + avgNeg;
    }
}
