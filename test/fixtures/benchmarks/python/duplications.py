# Two near-identical helpers — jscpd should detect this clone with
# default thresholds (--min-lines 5 --min-tokens 50). Phase 10i.0.3:
# per-language duplication fixture. Bodies are sized comfortably
# above the 50-token threshold so jscpd's tokenizer reliably matches
# regardless of small whitespace differences across runs.


def summarize_items_a(items):
    total = 0
    sum_positive = 0
    sum_negative = 0
    count_positive = 0
    count_negative = 0
    for item in items:
        if item > 0:
            total = total + item
            sum_positive = sum_positive + item
            count_positive = count_positive + 1
        else:
            total = total - item
            sum_negative = sum_negative + item
            count_negative = count_negative + 1
    avg_pos = sum_positive / count_positive if count_positive > 0 else 0
    avg_neg = sum_negative / count_negative if count_negative > 0 else 0
    return total + avg_pos + avg_neg


def summarize_items_b(items):
    total = 0
    sum_positive = 0
    sum_negative = 0
    count_positive = 0
    count_negative = 0
    for item in items:
        if item > 0:
            total = total + item
            sum_positive = sum_positive + item
            count_positive = count_positive + 1
        else:
            total = total - item
            sum_negative = sum_negative + item
            count_negative = count_negative + 1
    avg_pos = sum_positive / count_positive if count_positive > 0 else 0
    avg_neg = sum_negative / count_negative if count_negative > 0 else 0
    return total + avg_pos + avg_neg
