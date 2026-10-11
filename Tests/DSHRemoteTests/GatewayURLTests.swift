import XCTest
@testable import DSHRemote

final class GatewayURLTests: XCTestCase {
    func testTrimsAndRejectsNonHttps() {
        XCTAssertThrowsError(try GatewayURL.normalize(" http://x.ts.net "))
        XCTAssertThrowsError(try GatewayURL.normalize("not a url"))
        XCTAssertThrowsError(try GatewayURL.normalize(""))
    }

    func testAcceptsHttpsAndStripsTrailingSlash() throws {
        XCTAssertEqual(try GatewayURL.normalize("https://x.ts.net/"), "https://x.ts.net")
    }

    func testAcceptsHttpsWithPathPreserved() throws {
        XCTAssertEqual(try GatewayURL.normalize("https://x.ts.net/gw"), "https://x.ts.net/gw")
    }

    func testAcceptsHttpsWithPortPreserved() throws {
        XCTAssertEqual(try GatewayURL.normalize("https://x.ts.net:8443/"), "https://x.ts.net:8443")
    }

    func testRejectsMissingHost() {
        XCTAssertThrowsError(try GatewayURL.normalize("https://"))
    }
}
