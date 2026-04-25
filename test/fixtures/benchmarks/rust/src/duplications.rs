// Two near-identical helpers — jscpd should detect this clone with
// default thresholds (--min-lines 5 --min-tokens 50). Phase 10i.0.3:
// per-language duplication fixture. jscpd is text-based so it
// catches duplication regardless of whether the module is referenced
// from lib.rs.
pub fn summarize_items_a(items: &[i32]) -> i32 {
    let mut total = 0;
    let mut sum_positive = 0;
    let mut sum_negative = 0;
    let mut count_positive = 0;
    let mut count_negative = 0;
    for item in items {
        if *item > 0 {
            total += *item;
            sum_positive += *item;
            count_positive += 1;
        } else {
            total -= *item;
            sum_negative += *item;
            count_negative += 1;
        }
    }
    let avg_pos = if count_positive > 0 { sum_positive / count_positive } else { 0 };
    let avg_neg = if count_negative > 0 { sum_negative / count_negative } else { 0 };
    total + avg_pos + avg_neg
}

pub fn summarize_items_b(items: &[i32]) -> i32 {
    let mut total = 0;
    let mut sum_positive = 0;
    let mut sum_negative = 0;
    let mut count_positive = 0;
    let mut count_negative = 0;
    for item in items {
        if *item > 0 {
            total += *item;
            sum_positive += *item;
            count_positive += 1;
        } else {
            total -= *item;
            sum_negative += *item;
            count_negative += 1;
        }
    }
    let avg_pos = if count_positive > 0 { sum_positive / count_positive } else { 0 };
    let avg_neg = if count_negative > 0 { sum_negative / count_negative } else { 0 };
    total + avg_pos + avg_neg
}
