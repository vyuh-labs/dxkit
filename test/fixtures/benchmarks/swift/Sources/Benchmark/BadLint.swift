// Per-language badLint fixture, Swift row.
// Recipe v3 (G4) scaffolded — adjust syntax / linter rules as needed.
// Deliberate SwiftLint violations on default config:
//   - force_cast (error): `as!`
//   - force_try (error): `try!`
import Foundation

func badLint() -> Int {
    let anyValue: Any = 42
    let forced = anyValue as! Int
    let data = try! JSONSerialization.data(withJSONObject: ["k": forced])
    return data.count
}
