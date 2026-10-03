import XCTest
@testable import DSHRemote

final class GatewayURLTests: XCTestCase {
    func testTrimsAndRejectsNonHttps() {
        XCTAssertThrowsError(try GatewayURL.normalize(" http://x.ts.net "))
        XCTAssertThrowsError(try GatewayURL.normalize("not a url"))
        XCTAssertThrowsError(try GatewayURL.normalize(""))
    }

    func testAcceptsHttpsAndStripsTrailingSlash() throws {
        let (origin, shell) = try GatewayURL.normalize("https://x.ts.net/")
        XCTAssertEqual(origin, "https://x.ts.net")
        XCTAssertEqual(shell, "https://x.ts.net/__shell__/shell.html")
    }

    func testAcceptsHttpsWithPathPreserved() throws {
        let (origin, _) = try GatewayURL.normalize("https://x.ts.net/gw")
        XCTAssertEqual(origin, "https://x.ts.net/gw")
    }

    func testRejectsMissingHost() {
        XCTAssertThrowsError(try GatewayURL.normalize("https://"))
    }
}
