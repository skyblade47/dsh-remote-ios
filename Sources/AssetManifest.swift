import Foundation

enum AssetManifest {
    static let names: Set<String> = [
        "dsw-tokens.css", "writing.css", "ipad.css",
        "send.js", "watch.js", "editor-plain.js", "proofread.js",
        "sensitive-words.js", "sensitive.js", "search-core.js",
        "sync-core.js", "writing-count-core.js", "writing.js", "send-net.js",
        "proofread-net.js", "coach-net.js", "sync-net.js", "ipad.js",
        // 悬浮流式对话（2026-11-15 自 PC writing-client 移植）：纯逻辑 core + 网络接线 net + iOS 薄引导 boot
        "coach-chat-core.js", "coach-chat-net.js", "coach-chat-boot.js",
        // 创作教练 · 选中浮动 AI 工具条（2026-11-18 自 PC writing-client 移植）：
        // 工具条纯逻辑 + 身份路由 + 选区监听/直发接线
        "coach-toolbar.js", "coach-role.js", "coach-toolbar-net.js"
    ]

    static func isAsset(_ name: String) -> Bool {
        names.contains(name)
    }

    static func contentType(_ name: String) -> String {
        if name == "ping" { return "application/json; charset=utf-8" }
        let ext = (name.split(separator: ".", omittingEmptySubsequences: false).last).map(String.init) ?? ""
        switch ext {
        case "js": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        default: return "application/octet-stream"
        }
    }
}
