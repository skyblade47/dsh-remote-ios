import Foundation

enum RewriteError: LocalizedError {
    case hitCountMismatch(Int, Int)
    var errorDescription: String? {
        switch self {
        case let .hitCountMismatch(got, want):
            return "shell 资产引用命中数 \(got) 与白名单 \(want) 不一致"
        }
    }
}

enum ShellHTMLRewriter {
    // 注入用字面量锚点（必须是 /__shell__/ 形态，才能与 12 个外链一起被正则统一改写）
    private static let viewportOld = "viewport-fit=cover\""
    private static let viewportNew = "viewport-fit=cover, interactive-widget=resizes-content\""
    private static let cssAnchor = #"<link rel="stylesheet" href="/__shell__/writing.css" />"#
    private static let cssInjected = #"<link rel="stylesheet" href="/__shell__/ipad.css" />"#
    private static let jsAnchor = #"<script src="/__shell__/sync-net.js"></script>"#
    private static let jsInjected = #"<script src="/__shell__/ipad.js"></script>"#

    /// 仅在锚点存在且未注入过时插入，保证对任意输入（含测试里的无锚点片段）幂等、可重入。
    private static func injectOnce(_ html: String, anchor: String, insertion: String) -> String {
        guard html.contains(anchor), !html.contains(insertion) else { return html }
        return html.replacingOccurrences(of: anchor, with: anchor + "\n" + insertion)
    }

    static func rewrite(_ html: String) throws -> String {
        // 第一步：结构注入（插进去的仍是 /__shell__/ 字面量，与原 12 外链同走下面的正则）
        let withViewport = html.contains(viewportNew)
            ? html
            : html.replacingOccurrences(of: viewportOld, with: viewportNew)
        let withCSS = injectOnce(withViewport, anchor: cssAnchor, insertion: cssInjected)
        let withJS = injectOnce(withCSS, anchor: jsAnchor, insertion: jsInjected)

        // 第二步：白名单引用统一改写（既有逻辑，不动）
        var hits = 0
        let regex = try NSRegularExpression(
            pattern: #"/__shell__/([A-Za-z0-9._-]+\.(?:js|css))"#
        )
        let mutable = NSMutableString(string: withJS)
        let matches = regex.matches(in: withJS, range: NSRange(location: 0, length: (withJS as NSString).length))
        for m in matches.reversed() {
            let file = (withJS as NSString).substring(with: m.range(at: 1))
            guard AssetManifest.isAsset(file) else { continue }
            regex.replaceMatches(
                in: mutable, range: m.range(),
                withTemplate: "dsh-asset://local/\(file)"
            )
            hits += 1
        }
        guard hits == 0 || hits == AssetManifest.names.count else {
            throw RewriteError.hitCountMismatch(hits, AssetManifest.names.count)
        }
        return mutable as String
    }
}
