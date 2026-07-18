// Per-language badLint fixture, PHP row.
// Recipe v3 (G4) scaffolded — adjust syntax / linter rules as needed.
<?php
// Deliberate PHP_CodeSniffer violations on the PSR-12 standard:
//   - opening brace on the declaration line (PSR12.Functions)
//   - uppercase TRUE/FALSE (Generic.PHP.LowerCaseConstant)
function bad_lint($flag){ if ($flag === TRUE){ return 1; } return FALSE; }
