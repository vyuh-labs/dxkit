// Phase 10i.0.1 — per-language secret fixture, Kotlin row.
//
// Hardcoded fake AWS access key — gitleaks should flag this as
// `aws-access-token`. Pre-stages the assertion surface for the
// cross-ecosystem matrix.
//
// The key below is intentionally fake (low-entropy patterned digits +
// A-F) so it cannot be used to authenticate. Detected by gitleaks'
// regex on `AKIA[0-9A-Z]{16}` but allowlisted from real
// secret-scanning systems by virtue of being patterned.

class Secrets {
    companion object {
        const val AWS_ACCESS_KEY_ID = "AKIA1234567890ABCDEF"
    }
}
