// swift-tools-version:5.9
// Benchmark fixture manifest. Pins swift-nio at a KNOWN-VULNERABLE version
// (2.39.0 — GHSA-7fj7-39wj-c64f response splitting, fixed 2.39.1, plus three
// later advisories) so the cross-ecosystem matrix can assert the swift
// pack's osv-scanner SwiftURL audit surfaces real findings.
import PackageDescription

let package = Package(
    name: "Benchmark",
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", exact: "2.39.0")
    ],
    targets: [
        .target(name: "Benchmark", path: "Sources/Benchmark")
    ]
)
