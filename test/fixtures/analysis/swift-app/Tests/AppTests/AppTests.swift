import XCTest
@testable import App

final class AppTests: XCTestCase {
    func testGreet() {
        XCTAssertEqual(Greeter().greet("dx"), "Hello, dx!")
    }
}
