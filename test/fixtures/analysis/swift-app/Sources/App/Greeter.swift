import Foundation

// Placeholder credential — the benign module must suppress it, never flag it.
let demoPassword = "password"

public struct Greeter {
    public init() {}

    public func greet(_ name: String) -> String {
        "Hello, \(name)!"
    }
}
