import XCTest
@testable import DSHRemote

final class ShellHTMLRewriterTests: XCTestCase {
    func testRewritesWhitelistedRefs() throws {
        let html = #"<link href="/__shell__/dsw-tokens.css"><link href="/__shell__/writing.css"><script src="/__shell__/send.js"></script><script src="/__shell__/watch.js"></script><script src="/__shell__/editor-plain.js"></script><script src="/__shell__/proofread.js"></script><script src="/__shell__/sync-core.js"></script><script src="/__shell__/writing.js"></script><script src="/__shell__/send-net.js"></script><script src="/__shell__/proofread-net.js"></script><script src="/__shell__/sync-net.js"></script>"#
        let out = try ShellHTMLRewriter.rewrite(html)
        XCTAssertTrue(out.contains("dsh-asset://local/writing.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/writing.js"))
        XCTAssertFalse(out.contains("/__shell__/writing."))
    }

    func testKeepsIframeAndNonShellUrls() throws {
        let html = #"<iframe id="dsh-frame" src="/app#/"></iframe><a href="/auth/login">x</a>"#
        let out = try ShellHTMLRewriter.rewrite(html)
        XCTAssertTrue(out.contains("src=\"/app#/\""))
        XCTAssertTrue(out.contains("/auth/login"))
    }

    func testThrowsWhenHitCountMismatchesWhitelist() {
        let html = #"<script src="/__shell__/writing.js"></script>"#
        XCTAssertThrowsError(try ShellHTMLRewriter.rewrite(html))
    }
}
