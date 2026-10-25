import Foundation

/// 方案 D / 4.3：shell.html 注入器（纯字符串逻辑，模拟器可单测）。
///
/// 只做两处外链注入：
/// - ipad.css 插到 writing.css 锚点之后；
/// - ipad.js 插到 sync-net.js 锚点之后。
/// 不做 viewport 改写、dsh-asset 改写与全量内联——那些属于 Phase 5 将删除的 ShellHTMLRewriter。
enum ShellHTMLInjector {
    static let cssAnchor = #"<link rel="stylesheet" href="/__shell__/writing.css" />"#
    static let cssInsertion = #"<link rel="stylesheet" href="/__shell__/ipad.css" />"#
    static let jsAnchor = #"<script src="/__shell__/sync-net.js"></script>"#
    static let jsInsertion = #"<script src="/__shell__/ipad.js"></script>"#

    /// 依次注入 CSS / JS，各自幂等：锚点不存在或注入串已存在则原样返回。
    static func inject(_ html: String) -> String {
        var out = injectOnce(html, anchor: cssAnchor, insertion: cssInsertion)
        out = injectOnce(out, anchor: jsAnchor, insertion: jsInsertion)
        return out
    }

    private static func injectOnce(_ html: String, anchor: String, insertion: String) -> String {
        guard !html.contains(insertion),
              let range = html.range(of: anchor) else { return html }
        return html.replacingCharacters(in: range, with: anchor + "\n" + insertion)
    }
}
