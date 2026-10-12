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

    static func rewrite(_ html: String,
                        css: ((String) -> String?)? = nil,
                        js: ((String) -> String?)? = nil) throws -> String {
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
                in: mutable, range: m.range(at: 0),
                withTemplate: "dsh-asset://local/\(file)"
            )
            hits += 1
        }
        guard hits == 0 || hits == AssetManifest.names.count else {
            throw RewriteError.hitCountMismatch(hits, AssetManifest.names.count)
        }

        // 第三步：样式表与脚本内联。真机探针实锤（2026-10-12，探针 v1/v2）：https origin
        // 页面里自定义 scheme（dsh-asset://）的子资源被 WebKit 整批拦截——CSS 外链不应用、
        // 静态 <script src> 与动态插入的 script 均 onerror（tag in DOM=YES 但 executed=NO）。
        // 早前「同 scheme script 正常执行」的注释结论证伪。把白名单样式表换成 <style>、
        // 白名单脚本换成 <script data-asset>，壳页面零子资源依赖，从根上绕开拦截；
        // 提供不出内容的资产保留外链（不影响无 Bundle 的测试/调用方）。
        // 幂等：输入已是 <style data-asset>/<script data-asset> 时无外链可换。
        let cssInlined = inlineStylesheets(mutable as String, css: css)
        return inlineScripts(cssInlined, js: js)
    }

    /// 把 `<link rel="stylesheet" href="dsh-asset://local/<name>.css" ...>` 就地替换为
    /// `<style data-asset="<name>">…</style>`（css 闭包返回 nil 则保留原 link）。
    private static func inlineStylesheets(_ html: String, css: ((String) -> String?)?) -> String {
        guard let css else { return html }
        let linkRegex = try? NSRegularExpression(
            pattern: #"<link\s+rel="stylesheet"\s+href="dsh-asset://local/([A-Za-z0-9._-]+\.css)"\s*/?>"#
        )
        guard let linkRegex else { return html }
        let source = html as NSString
        let matches = linkRegex.matches(in: html, range: NSRange(location: 0, length: source.length))
        var out = html
        for m in matches.reversed() {
            let name = source.substring(with: m.range(at: 1))
            guard AssetManifest.isAsset(name), let body = css(name) else { continue }
            guard let nsRange = Range(m.range, in: out) else { continue }
            out.replaceSubrange(nsRange, with: #"<style data-asset="\#(name)">\#(body)</style>"#)
        }
        return out
    }

    /// 把 `<script src="dsh-asset://local/<name>.js"></script>` 就地替换为
    /// `<script data-asset="<name>">…</script>`（js 闭包返回 nil 则保留原外链）。
    /// 内容里的 `</script` 一律转义为 `<\/script`（HTML 解析只认它闭合脚本；
    /// 字符串/正则/注释语境下 `\/` 与 `/` 等价，JS 语义不变，大小写不敏感）。
    private static func inlineScripts(_ html: String, js: ((String) -> String?)?) -> String {
        guard let js else { return html }
        let scriptRegex = try? NSRegularExpression(
            pattern: #"<script\s+src="dsh-asset://local/([A-Za-z0-9._-]+\.js)"\s*></script>"#
        )
        guard let scriptRegex else { return html }
        let source = html as NSString
        let matches = scriptRegex.matches(in: html, range: NSRange(location: 0, length: source.length))
        var out = html
        for m in matches.reversed() {
            let name = source.substring(with: m.range(at: 1))
            guard AssetManifest.isAsset(name), let body = js(name) else { continue }
            guard let nsRange = Range(m.range, in: out) else { continue }
            let safe = body.replacingOccurrences(
                of: "</script", with: #"<\/script"#, options: .caseInsensitive
            )
            out.replaceSubrange(nsRange, with: #"<script data-asset="\#(name)">\#(safe)</script>"#)
        }
        return out
    }
}
