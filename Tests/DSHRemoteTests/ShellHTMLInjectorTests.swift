import XCTest
@testable import DSHRemote

final class ShellHTMLInjectorTests: XCTestCase {
    private let fixture = #"""
    <html><head>
    <link rel="stylesheet" href="/__shell__/dsw-tokens.css" />
    <link rel="stylesheet" href="/__shell__/writing.css" />
    <style>body{}</style>
    </head><body>
    <script src="/__shell__/sync-core.js"></script>
    <script src="/__shell__/sync-net.js"></script>
    <script>console.log("inline");</script>
    </body></html>
    """#

    func testInjectsBothAfterAnchors() {
        let out = ShellHTMLInjector.inject(fixture)
        guard let cssRange = out.range(of: ShellHTMLInjector.cssAnchor),
              let cssInjRange = out.range(of: ShellHTMLInjector.cssInsertion),
              let styleRange = out.range(of: "<style>"),
              let jsRange = out.range(of: ShellHTMLInjector.jsAnchor),
              let jsInjRange = out.range(of: ShellHTMLInjector.jsInsertion),
              let inlineRange = out.range(#"<script>console"#) else {
            return XCTFail("注入点或锚点缺失")
        }
        // CSS：锚点 < 注入 < <style>
        XCTAssertLessThan(cssRange.upperBound, cssInjRange.lowerBound)
        XCTAssertLessThan(cssInjRange.upperBound, styleRange.lowerBound)
        // JS：锚点 < 注入 < 内联脚本
        XCTAssertLessThan(jsRange.upperBound, jsInjRange.lowerBound)
        XCTAssertLessThan(jsInjRange.upperBound, inlineRange.lowerBound)
    }

    func testInjectionIsIdempotent() {
        let once = ShellHTMLInjector.inject(fixture)
        let twice = ShellHTMLInjector.inject(once)
        XCTAssertEqual(once, twice)
        XCTAssertEqual(
            twice.components(separatedBy: ShellHTMLInjector.cssInsertion).count - 1, 1)
        XCTAssertEqual(
            twice.components(separatedBy: ShellHTMLInjector.jsInsertion).count - 1, 1)
    }

    func testMissingAnchorLeavesHtmlUntouched() {
        let bare = "<html><head></head><body>nothing</body></html>"
        XCTAssertEqual(ShellHTMLInjector.inject(bare), bare)
    }
}
