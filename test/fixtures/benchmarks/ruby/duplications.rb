# Per-language duplications fixture, Ruby row.
# Recipe v3 (G4) scaffolded — adjust syntax / linter rules as needed.
# Two near-identical methods — jscpd should detect this clone with
# default thresholds (--min-lines 5 --min-tokens 50).
def summarize_items_a(items)
  total = 0
  sum_positive = 0
  sum_negative = 0
  count_positive = 0
  count_negative = 0
  items.each do |item|
    if item > 0
      total = total + item
      sum_positive = sum_positive + item
      count_positive = count_positive + 1
    else
      total = total - item
      sum_negative = sum_negative + item
      count_negative = count_negative + 1
    end
  end
  avg_pos = count_positive > 0 ? sum_positive.to_f / count_positive : 0.0
  avg_neg = count_negative > 0 ? sum_negative.to_f / count_negative : 0.0
  total + avg_pos + avg_neg
end

def summarize_items_b(items)
  total = 0
  sum_positive = 0
  sum_negative = 0
  count_positive = 0
  count_negative = 0
  items.each do |item|
    if item > 0
      total = total + item
      sum_positive = sum_positive + item
      count_positive = count_positive + 1
    else
      total = total - item
      sum_negative = sum_negative + item
      count_negative = count_negative + 1
    end
  end
  avg_pos = count_positive > 0 ? sum_positive.to_f / count_positive : 0.0
  avg_neg = count_negative > 0 ? sum_negative.to_f / count_negative : 0.0
  total + avg_pos + avg_neg
end
