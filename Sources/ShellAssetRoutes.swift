import Foundation

/// 方案 D / 4.2：`/__shell__/` 本地壳路由（纯逻辑，模拟器可单测）。
///
/// - shell.html：读本地资源、经 ShellHTMLInjector 注入后应答；
/// - ping：健康探针；
/// - 其余 18 件白名单资产：按 AssetManifest 的 content-type 应答；
/// - 一律 `Cache-Control: no-store`（WKWebView 对壳资源不得用缓存副本）；
/// - 白名单之外的任何名字（含路径分隔符、点段、NUL）一律 404，杜绝路径穿越。
final class ShellAssetRoutes {
    static let prefix = "/__shell__/"

    private let loadData: (String) -> Data?

    init(loadData: @escaping (String) -> Data?) {
        self.loadData = loadData
    }

    /// 命中本地路由返回完整 raw 响应（HEAD 不含 body）；未命中（非 /__shell__/）返回 nil 转交上游。
    func respond(method: String, target: String) -> Data? {
        let path = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
            .first.map(String.init) ?? target
        guard path.hasPrefix(Self.prefix) else { return nil }
        let name = String(path.dropFirst(Self.prefix.count))

        // 穿越防护：先于一切处理。合法资产名不含分隔符/点段/NUL。
        guard !name.isEmpty,
              !name.contains("/"), !name.contains("\\"),
              !name.contains(".."), !name.contains("\0") else {
            return errorResponse(method, status: 404, reason: "Not Found")
        }

        guard method == "GET" || method == "HEAD" else {
            return errorResponse(method, status: 405, reason: "Method Not Allowed")
        }

        if name == "shell.html" {
            guard let raw = loadData(name) else {
                return errorResponse(method, status: 404, reason: "Not Found")
            }
            let injected = ShellHTMLInjector.inject(String(decoding: raw, as: UTF8.self))
            return response(method, contentType: "text/html; charset=utf-8",
                            body: Data(injected.utf8))
        }

        if name == "ping" {
            return response(method, contentType: "application/json; charset=utf-8",
                            body: Data(#"{"ok":true,"echo":"pong"}"#.utf8))
        }

        guard AssetManifest.isAsset(name), let body = loadData(name) else {
            return errorResponse(method, status: 404, reason: "Not Found")
        }
        return response(method, contentType: AssetManifest.contentType(name), body: body)
    }

    private func response(_ method: String, contentType: String, body: Data) -> Data {
        let head = HTTPHeadCodec.serializeResponse(status: 200, reason: "OK", headers: [
            ("Content-Type", contentType),
            ("Content-Length", "\(body.count)"),
            ("Cache-Control", "no-store"),
            ("Connection", "close")
        ])
        return method == "HEAD" ? head : head + body
    }

    private func errorResponse(_ method: String, status: Int, reason: String) -> Data? {
        let body = Data("{\"ok\":false,\"error\":\"\(reason.lowercased().replacingOccurrences(of: " ", with: "-"))\"}".utf8)
        let head = HTTPHeadCodec.serializeResponse(status: status, reason: reason, headers: [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", "\(body.count)"),
            ("Cache-Control", "no-store"),
            ("Connection", "close")
        ])
        return method == "HEAD" ? head : head + body
    }
}
