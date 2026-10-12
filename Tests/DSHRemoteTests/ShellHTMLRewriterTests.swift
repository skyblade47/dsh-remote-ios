import XCTest
@testable import DSHRemote

final class ShellHTMLRewriterTests: XCTestCase {
    // 与 ShellAssets/shell.html 的 2 个 CSS 外链同构（head，顺序一致）
    private let cssRefs = #"""
<link rel="stylesheet" href="/__shell__/dsw-tokens.css" />
<link rel="stylesheet" href="/__shell__/writing.css" />
"""#

    // 与 ShellAssets/shell.html 的 10 个 JS 外链同构（body，顺序一致）
    private let jsRefs = #"""
<script src="/__shell__/send.js"></script>
<script src="/__shell__/watch.js"></script>
<script src="/__shell__/editor-plain.js"></script>
<script src="/__shell__/proofread.js"></script>
<script src="/__shell__/sync-core.js"></script>
<script src="/__shell__/writing-count-core.js"></script>
<script src="/__shell__/writing.js"></script>
<script src="/__shell__/send-net.js"></script>
<script src="/__shell__/proofread-net.js"></script>
<script src="/__shell__/sync-net.js"></script>
"""#

    private let shellDoc = #"""
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>写作客户端</title>
__CSS__
<style>
  html, body { margin: 0; }
</style>
</head>
<body>
__JS__
<script>
    // 两页常驻 + display( hidden ) 显隐：不销毁重建（与 shell.html:728-729 同构）
</script>
</body>
</html>
"""#

    private var fullHTML: String {
        shellDoc
            .replacingOccurrences(of: "__CSS__", with: cssRefs)
            .replacingOccurrences(of: "__JS__", with: jsRefs)
    }

    func testRewritesFourteenRefsAndInjectsIPadAssets() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML)
        XCTAssertFalse(out.contains("/__shell__/"))
        XCTAssertTrue(out.contains("dsh-asset://local/dsw-tokens.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/writing.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/writing.js"))
        XCTAssertTrue(out.contains("dsh-asset://local/sync-net.js"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.js"))
        // ipad.css 紧跟 writing.css（级联顺序：壳侧覆盖必须最后）
        let cssAnchor = try XCTUnwrap(out.range(of: "dsh-asset://local/writing.css"))
        let ipadCss = try XCTUnwrap(out.range(of: "dsh-asset://local/ipad.css"))
        let styleTag = try XCTUnwrap(out.range(of: "<style>"))
        XCTAssertLessThan(cssAnchor.upperBound, ipadCss.lowerBound)
        XCTAssertLessThan(ipadCss.lowerBound, styleTag.lowerBound)
        // ipad.js 紧跟 sync-net.js，且在页尾内联脚本之前
        let syncNet = try XCTUnwrap(out.range(of: "dsh-asset://local/sync-net.js"))
        let ipadJs = try XCTUnwrap(out.range(of: "dsh-asset://local/ipad.js"))
        let inlineJs = try XCTUnwrap(out.range(of: "<script>\n    // 两页常驻"))
        XCTAssertLessThan(syncNet.upperBound, ipadJs.lowerBound)
        XCTAssertLessThan(ipadJs.lowerBound, inlineJs.lowerBound)
    }

    func testViewportMetaGetsInteractiveWidget() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML)
        XCTAssertTrue(out.contains("interactive-widget=resizes-content"))
        XCTAssertFalse(out.contains("viewport-fit=cover\""))
        XCTAssertTrue(out.contains("viewport-fit=cover, interactive-widget=resizes-content"))
    }

    func testInjectionIsIdempotent() throws {
        let once = try ShellHTMLRewriter.rewrite(fullHTML)
        let twice = try ShellHTMLRewriter.rewrite(once)
        XCTAssertEqual(once, twice)
        XCTAssertEqual(twice.components(separatedBy: "ipad.css").count - 1, 1)
        XCTAssertEqual(twice.components(separatedBy: "ipad.js").count - 1, 1)
        XCTAssertEqual(twice.components(separatedBy: "interactive-widget=resizes-content").count - 1, 1)
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

    // 默认 css: 内联。提供内容的白名单样式表被换成 <style>（自定义 scheme 下外链
    // stylesheet 不被 WebKit 应用，而 <script> 正常；内联绕开该非对称行为），级联顺序不变。
    func testInlinesCSSByDefaultWhileScriptsStayOnScheme() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML, css: { name in
            name == "writing.css" ? "W{color:red}" : nil
        })
        // writing.css 提供了内容 ⇒ 内联，且不再保留其外链
        XCTAssertTrue(out.contains(#"<style data-asset="writing.css">W{color:red}</style>"#))
        XCTAssertFalse(out.contains("dsh-asset://local/writing.css"))
        // 未提供内容的样式表 ⇒ 保留外链（不因内联器丢样式）
        XCTAssertTrue(out.contains("dsh-asset://local/dsw-tokens.css"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.css"))
        // 级联顺序：tokens → writing(内联) → ipad(外链)
        let tokens = try XCTUnwrap(out.range(of: "dsh-asset://local/dsw-tokens.css"))
        let writing = try XCTUnwrap(out.range(of: #"<style data-asset="writing.css">"#))
        let ipad = try XCTUnwrap(out.range(of: "dsh-asset://local/ipad.css"))
        XCTAssertLessThan(tokens.upperBound, writing.lowerBound)
        XCTAssertLessThan(writing.upperBound, ipad.lowerBound)
        // JS 一律仍走自定义 scheme（只有样式表内联）
        XCTAssertTrue(out.contains("dsh-asset://local/writing.js"))
        XCTAssertFalse(out.contains(#"<style data-asset="writing.js">"#))
    }

    func testCSSInlineIsIdempotent() throws {
        let once = try ShellHTMLRewriter.rewrite(fullHTML, css: { name in
            name == "writing.css" ? "W{color:red}" : nil
        })
        let twice = try ShellHTMLRewriter.rewrite(once, css: { name in
            name == "writing.css" ? "W{color:red}" : nil
        })
        XCTAssertEqual(once, twice)
        XCTAssertEqual(twice.components(separatedBy: #"<style data-asset="writing.css">"#).count - 1, 1)
    }

    // css: nil ⇒ 旧行为（全部保留外链），供无 Bundle 的测试/调用方使用。
    func testNilCSSProviderKeepsExternalStylesheetLinks() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML, css: nil)
        XCTAssertTrue(out.contains("dsh-asset://local/writing.css"))
        XCTAssertFalse(out.contains(#"<style data-asset=""#))
    }
}
