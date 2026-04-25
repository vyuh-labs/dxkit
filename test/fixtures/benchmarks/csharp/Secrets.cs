// Hardcoded fake AWS access key — gitleaks should flag this as
// `aws-access-token`. Phase 10i.0.1: per-language secret fixture
// pre-staging the cross-ecosystem assertion surface for 10i.2
// (SecretFinding fingerprints).
//
// The key below is intentionally fake (low-entropy, no valid AWS
// checksum) so it cannot be used to authenticate.
namespace Dxkit.Benchmark;

public static class Secrets
{
    public const string AwsAccessKeyId = "AKIA1234567890ABCDEF";
}
