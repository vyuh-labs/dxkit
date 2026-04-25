// Two near-identical helpers — jscpd should detect this clone with
// default thresholds (--min-lines 5 --min-tokens 50). Phase 10i.0.3:
// per-language duplication fixture (multi-project variant).
namespace ProjectA;

public static class Duplications
{
    public static int SummarizeItemsA(int[] items)
    {
        var total = 0;
        var sumPositive = 0;
        var sumNegative = 0;
        var countPositive = 0;
        var countNegative = 0;
        foreach (var item in items)
        {
            if (item > 0)
            {
                total = total + item;
                sumPositive = sumPositive + item;
                countPositive = countPositive + 1;
            }
            else
            {
                total = total - item;
                sumNegative = sumNegative + item;
                countNegative = countNegative + 1;
            }
        }
        var avgPos = countPositive > 0 ? sumPositive / countPositive : 0;
        var avgNeg = countNegative > 0 ? sumNegative / countNegative : 0;
        return total + avgPos + avgNeg;
    }

    public static int SummarizeItemsB(int[] items)
    {
        var total = 0;
        var sumPositive = 0;
        var sumNegative = 0;
        var countPositive = 0;
        var countNegative = 0;
        foreach (var item in items)
        {
            if (item > 0)
            {
                total = total + item;
                sumPositive = sumPositive + item;
                countPositive = countPositive + 1;
            }
            else
            {
                total = total - item;
                sumNegative = sumNegative + item;
                countNegative = countNegative + 1;
            }
        }
        var avgPos = countPositive > 0 ? sumPositive / countPositive : 0;
        var avgNeg = countNegative > 0 ? sumNegative / countNegative : 0;
        return total + avgPos + avgNeg;
    }
}
