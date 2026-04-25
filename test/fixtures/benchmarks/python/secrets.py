# Hardcoded fake AWS access key — gitleaks should flag this as
# `aws-access-token`. Phase 10i.0.1: per-language secret fixture
# pre-staging the cross-ecosystem assertion surface for 10i.2
# (SecretFinding fingerprints).
#
# The key below is intentionally fake (low-entropy, no valid AWS
# checksum) so it cannot be used to authenticate. It is detected by
# gitleaks' regex on `AKIA[0-9A-Z]{16}` but allowlisted from real
# secret-scanning systems by virtue of being patterned digits + A-F.
AWS_ACCESS_KEY_ID = "AKIA1234567890ABCDEF"
