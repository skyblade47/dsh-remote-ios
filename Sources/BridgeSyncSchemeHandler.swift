import Foundation
import WebKit

// 同步桥内核：URLRequest → (status, Content-Type, body)，不依赖 WebKit，可直接单测。
final class BridgeSyncBridge {
    struct Answer {
        let status: Int
        let contentType: String
        let body: Data
    }

    private static let jsonType = "application/json; charset=utf-8"
    private static let syncMethods: Set<String> = ["writeDocSync", "writeDraftSync"]

    private let dispatcher: BridgeDispatcher

    init(dispatcher: BridgeDispatcher) {
        self.dispatcher = dispatcher
    }

    func answer(to request: URLRequest) -> Answer {
        // 探针（Task 3 S1 第⑤项）：dsh-bridge://sync?m=__ping__
        if request.url?.queryParameter("m") == "__ping__" {
            return json(200, ["ok": true, "echo": "pong"])
        }

        guard let body = request.httpBody ?? Self.readBodyStream(request) else {
            return badRequest("缺少请求体")
        }
        guard let obj = try? JSONSerialization.jsonObject(with: body, options: []),
              let dict = obj as? [String: Any] else {
            return badRequest("请求体必须是 JSON 对象")
        }
        guard let method = dict["method"] as? String else {
            return badRequest("method 缺失或不是字符串")
        }
        // 缺省 []；args 存在但非数组 → 协议错
        let args: [Any]
        if dict["args"] == nil || dict["args"] is NSNull {
            args = []
        } else if let arr = dict["args"] as? [Any] {
            args = arr
        } else {
            return badRequest("args 必须是数组")
        }

        guard Self.syncMethods.contains(method) else {
            // 业务失败形态（对齐安卓 call()：任何方法都经同一同步入口返回 JSON，不抛异常）
            return json(200, ["ok": false, "error": "该方法不允许走同步通道（仅允许同步方法 writeDocSync/writeDraftSync）: \(method)"])
        }

        let map = dispatcher.dispatch(method, args: args)
        return json(200, map)
    }

    private func badRequest(_ msg: String) -> Answer {
        json(400, ["ok": false, "error": msg])
    }

    private func json(_ status: Int, _ map: [String: Any]) -> Answer {
        let data: Data
        if let d = try? JSONSerialization.data(withJSONObject: map) {
            data = d
        } else {
            data = Data("{\"ok\":false,\"error\":\"应答序列化失败\"}".utf8)
        }
        return Answer(status: status, contentType: Self.jsonType, body: data)
    }

    // WKURLSchemeTask 的同步 XHR 请求体可能落在 httpBodyStream（无 NSURLRequest 直接 body 时）
    static func readBodyStream(_ request: URLRequest) -> Data? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        let cap = 8 * 1024
        var out = Data()
        let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: cap)
        defer { buf.deallocate() }
        while stream.hasBytesAvailable {
            let n = stream.read(buf, maxLength: cap)
            if n < 0 { return nil }
            if n == 0 { break }
            out.append(buf, count: n)
        }
        return out.isEmpty ? nil : out
    }
}

// WKWebView 适配：读请求 → 内核 → didReceive/didFinish
final class BridgeSyncSchemeHandler: NSObject, WKURLSchemeHandler {
    private let bridge: BridgeSyncBridge

    init(dispatcher: BridgeDispatcher) {
        self.bridge = BridgeSyncBridge(dispatcher: dispatcher)
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let answer = bridge.answer(to: urlSchemeTask.request)
        guard let url = urlSchemeTask.request.url,
              let response = HTTPURLResponse(
                url: url, statusCode: answer.status, httpVersion: "HTTP/1.1",
                headerFields: [
                    "Content-Type": answer.contentType,
                    "Content-Length": "\(answer.body.count)",
                    "Access-Control-Allow-Origin": "*"
                ]) else {
            urlSchemeTask.didFailWithError(NSError(domain: "dsh-bridge", code: -1))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(answer.body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

private extension URL {
    func queryParameter(_ key: String) -> String? {
        URLComponents(url: self, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first { $0.name == key }?
            .value
    }
}
