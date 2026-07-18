// Per-language secrets fixture, PHP row.
// Recipe v3 (G4) scaffolded — adjust syntax / linter rules as needed.
<?php
// Hardcoded fake AWS access key — gitleaks should flag this as
// `aws-access-token`. Per-language secret fixture pre-staging the
// cross-ecosystem assertion surface.
//
// The key below is intentionally fake (low-entropy, no valid AWS
// checksum) so it cannot be used to authenticate.
$awsAccessKeyId = "AKIA1234567890ABCDEF";
