import Foundation

enum AssetManifest {
    static let names: Set<String> = [
        "dsw-tokens.css", "writing.css", "ipad.css",
        "send.js", "watch.js", "editor-plain.js", "proofread.js",
        "sensitive-words.js", "sensitive.js", "search-core.js",
        "sync-core.js", "writing-count-core.js", "writing.js", "send-net.js",
        "proofread-net.js", "sync-net.js", "ipad.js"
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
