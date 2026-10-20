import XCTest
@testable import DSHRemote

final class ShellHTMLRewriterTests: XCTestCase {
    // 与 ShellAssets/shell.html 的 2 个 CSS 外链同构（head，顺序一致）
    private let cssRefs = #"""
<link rel="stylesheet" href="/__shell__/dsw-tokens.css" />
<link rel="stylesheet" href="/__shell__/writing.css" />
"""#

    // 与 ShellAssets/shell.html 的 14 个 JS 外链同构（body，顺序一致）
    private let jsRefs = #"""
<script src="/__shell__/send.js"></script>
<script src="/__shell__/watch.js"></script>
<script src="/__shell__/editor-plain.js"></script>
<script src="/__shell__/proofread.js"></script>
<script src="/__shell__/sensitive-words.js"></script>
<script src="/__shell__/sensitive.js"></script>
<script src="/__shell__/sync-core.js"></script>
<script src="/__shell__/writing-count-core.js"></script>
<script src="/__shell__/search-core.js"></script>
<script src="/__shell__/writing.js"></script>
<script src="/__shell__/send-net.js"></script>
<script src="/__shell__/proofread-net.js"></script>
<script src="/__shell__/coach-net.js"></script>
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

    func testRewritesEighteenRefsAndInjectsIPadAssets() throws {
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

    // MARK: - 脚本内联（2026-10-12 真机探针实锤后的根因修复）

    // 真机探针实锤：https origin 下自定义 scheme 子资源整批被拦（CSS 外链不应用、
    // 静态与动态插入的 script 均 onerror，ipad.js tag in DOM=YES 但 executed=NO）
    // ⇒ JS 与 CSS 同法内联，壳页面零子资源依赖。
    func testInlinesJSWhenProviderGiven() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML, js: { name in
            name == "writing.js" ? "var W=1" : nil
        })
        // writing.js 提供了内容 ⇒ 内联，且不再保留其外链
        XCTAssertTrue(out.contains(#"<script data-asset="writing.js">var W=1</script>"#))
        XCTAssertFalse(out.contains("dsh-asset://local/writing.js"))
        // 未提供内容的脚本 ⇒ 保留外链（不因内联器丢功能）
        XCTAssertTrue(out.contains("dsh-asset://local/send-net.js"))
        XCTAssertTrue(out.contains("dsh-asset://local/ipad.js"))
        // 执行顺序：sync-core(外链) → writing(内联) → send-net(外链)
        let syncCore = try XCTUnwrap(out.range(of: "dsh-asset://local/sync-core.js"))
        let writing = try XCTUnwrap(out.range(of: #"<script data-asset="writing.js">"#))
        let sendNet = try XCTUnwrap(out.range(of: "dsh-asset://local/send-net.js"))
        XCTAssertLessThan(syncCore.upperBound, writing.lowerBound)
        XCTAssertLessThan(writing.upperBound, sendNet.lowerBound)
        // 样式表不受脚本内联影响
        XCTAssertTrue(out.contains("dsh-asset://local/writing.css"))
        XCTAssertFalse(out.contains(#"<script data-asset="writing.css">"#))
    }

    // HTML 解析只认 </script 闭合：内联内容里的该串转义为 <\/script（JS 语义不变，
    // 大小写不敏感）。当前 18 个资产均无此串（已全量扫描），此为防御未来资产变更。
    func testScriptInlineEscapesClosingTag() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML, js: { name in
            name == "writing.js" ? "var a=1</script>var b=2</SCRIPT>var c=3" : nil
        })
        // 大小写不敏感匹配、统一替换为小写形式（JS 字符串/正则/注释语境下语义不变）
        XCTAssertTrue(out.contains(#"var a=1<\/script>var b=2<\/script>var c=3"#))
        XCTAssertFalse(out.contains("</script>var b"))
    }

    func testJSInlineIsIdempotent() throws {
        let js: (String) -> String? = { name in name == "writing.js" ? "var W=1" : nil }
        let once = try ShellHTMLRewriter.rewrite(fullHTML, js: js)
        let twice = try ShellHTMLRewriter.rewrite(once, js: js)
        XCTAssertEqual(once, twice)
        XCTAssertEqual(twice.components(separatedBy: #"<script data-asset="writing.js">"#).count - 1, 1)
    }

    // js: nil ⇒ 旧行为（全部保留外链），供无 Bundle 的测试/调用方使用。
    func testNilJSProviderKeepsExternalScriptTags() throws {
        let out = try ShellHTMLRewriter.rewrite(fullHTML, js: nil)
        XCTAssertTrue(out.contains("dsh-asset://local/writing.js"))
        XCTAssertFalse(out.contains(#"<script data-asset=""#))
    }

    // 真机形态：css/js 闭包全给 ⇒ 壳页面不再引用任何自定义 scheme 子资源。
    func testFullInlineLeavesNoSchemeSubresources() throws {
        let out = try ShellHTMLRewriter.rewrite(
            fullHTML,
            css: { _ in "C{}" },
            js: { _ in "var x=1" }
        )
        XCTAssertFalse(out.contains("dsh-asset://local/"))
        XCTAssertFalse(out.contains(#"<script src="#))
        XCTAssertFalse(out.contains(#"<link rel="stylesheet""#))
    }
}
