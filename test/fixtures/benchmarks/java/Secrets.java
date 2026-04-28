// Phase 10k.1.0 — per-language secret fixture, Java row.
//
// Hardcoded fake AWS access key — gitleaks should flag this as
// `aws-access-token`. Pre-stages the assertion surface for the
// cross-ecosystem matrix.
//
// The key below is intentionally fake (low-entropy patterned digits +
// A-F) so it cannot be used to authenticate. Detected by gitleaks'
// regex on `AKIA[0-9A-Z]{16}` but allowlisted from real
// secret-scanning systems by virtue of being patterned.

public class Secrets {
    public static final String AWS_ACCESS_KEY_ID = "AKIA1234567890ABCDEF";
}
