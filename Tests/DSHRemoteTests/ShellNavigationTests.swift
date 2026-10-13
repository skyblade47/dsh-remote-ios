import XCTest
@testable import DSHRemote

final class ShellNavigationTests: XCTestCase {
    func testBundleShellHTMLRewritesSeventeenReferences() throws {
        let url = try XCTUnwrap(Bundle(for: ShellNavigationTests.self)
            .url(forResource: "shell", withExtension: "html"))
        let raw = try String(contentsOf: url, encoding: .utf8)
        let out = try ShellHTMLRewriter.rewrite(raw)
        XCTAssertEqual(out.components(separatedBy: "dsh-asset://local/").count - 1, 17)
        XCTAssertTrue(out.contains("dsh-asset://local/sensitive-words.js"))
        XCTAssertTrue(out.contains("dsh-asset://local/sensitive.js"))
        XCTAssertTrue(out.contains("dsh-asset://local/search-core.js"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.js"))
        XCTAssertFalse(out.contains("/__shell__/"))
        XCTAssertTrue(out.contains("src=\"/app#/\""))
    }
}
