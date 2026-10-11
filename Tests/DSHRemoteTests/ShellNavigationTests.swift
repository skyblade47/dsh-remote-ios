import XCTest
@testable import DSHRemote

final class ShellNavigationTests: XCTestCase {
    func testBundleShellHTMLRewritesFourteenReferences() throws {
        let url = try XCTUnwrap(Bundle(for: ShellNavigationTests.self)
            .url(forResource: "shell", withExtension: "html"))
        let raw = try String(contentsOf: url, encoding: .utf8)
        let out = try ShellHTMLRewriter.rewrite(raw)
        XCTAssertEqual(out.components(separatedBy: "dsh-asset://local/").count - 1, 14)
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.js"))
        XCTAssertFalse(out.contains("/__shell__/"))
        XCTAssertTrue(out.contains("src=\"/app#/\""))
    }

    func testShouldTakeOverShellNavigation() {
        XCTAssertTrue(ShellNavPolicy.shouldTakeOver(mainFrame: true,
            url: URL(string: "https://gw.example.com/__shell__/shell.html")!))
        XCTAssertFalse(ShellNavPolicy.shouldTakeOver(mainFrame: false,
            url: URL(string: "https://gw.example.com/__shell__/shell.html")!))
        XCTAssertFalse(ShellNavPolicy.shouldTakeOver(mainFrame: true,
            url: URL(string: "https://gw.example.com/app#/")!))
        XCTAssertFalse(ShellNavPolicy.shouldTakeOver(mainFrame: true,
            url: URL(string: "https://gw.example.com/auth/login")!))
    }
}
