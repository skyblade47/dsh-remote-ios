import XCTest
@testable import DSHRemote

final class ShellOriginTests: XCTestCase {
    func testEmptyGatewayFallsBackToPlaceholder() {
        XCTAssertEqual(ShellOrigin.resolve(gatewayRaw: ""), ShellOrigin.placeholder)
        XCTAssertEqual(ShellOrigin.resolve(gatewayRaw: "   "), ShellOrigin.placeholder)
    }

    func testInvalidGatewayFallsBackToPlaceholder() {
        XCTAssertEqual(ShellOrigin.resolve(gatewayRaw: "http://x.ts.net"), ShellOrigin.placeholder)
        XCTAssertEqual(ShellOrigin.resolve(gatewayRaw: "not a url"), ShellOrigin.placeholder)
        XCTAssertEqual(ShellOrigin.resolve(gatewayRaw: "https://"), ShellOrigin.placeholder)
    }

    func testValidHttpsGatewayUsesItsOrigin() {
        XCTAssertEqual(ShellOrigin.resolve(gatewayRaw: "https://x.ts.net/"), "https://x.ts.net")
        XCTAssertEqual(ShellOrigin.resolve(gatewayRaw: "https://x.ts.net/gw"), "https://x.ts.net/gw")
        XCTAssertEqual(ShellOrigin.resolve(gatewayRaw: "  https://x.ts.net  "), "https://x.ts.net")
    }

    func testPlaceholderIsHttpsParsableOrigin() {
        let url = URL(string: ShellOrigin.placeholder)
        XCTAssertEqual(url?.scheme, "https")
        XCTAssertNotNil(url?.host)
        XCTAssertTrue(ShellOrigin.placeholder.hasSuffix("/"))
    }
}
