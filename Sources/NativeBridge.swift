import Foundation
import WebKit

final class NativeBridge: NSObject, WKScriptMessageHandler {

    private let dispatcher: BridgeDispatcher
    private let ioQueue: DispatchQueue
    private let reply: (Any, String) -> Void

    init(dispatcher: BridgeDispatcher,
         reply: @escaping (Any, String) -> Void,
         ioQueue: DispatchQueue = DispatchQueue(label: "dsh.bridge.io")) {
        self.dispatcher = dispatcher
        self.reply = reply
        self.ioQueue = ioQueue
    }

    convenience init(dispatcher: BridgeDispatcher, webView: WKWebView) {
        self.init(dispatcher: dispatcher, reply: { [weak webView] id, json in
            let script = Self.replyScript(id: id, json: json)
            if Thread.isMainThread {
                webView?.evaluateJavaScript(script)
            } else {
                DispatchQueue.main.async { webView?.evaluateJavaScript(script) }
            }
        })
    }

    // MARK: - WKScriptMessageHandler（薄适配：主线程收包）

    func userContentController(_ controller: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.name == "dshBridge" else { return }
        handle(body: message.body)
    }

    // MARK: - 可测内核（不依赖 WebKit）

    func handle(body: Any?) {
        let packet: [String: Any]
        if let dict = body as? [String: Any] {
            packet = dict
        } else if let text = body as? String,
                  let parsed = try? JSONSerialization.jsonObject(
                    with: Data(text.utf8), options: [.fragmentsAllowed]),
                  let dict = parsed as? [String: Any] {
            packet = dict
        } else {
            return
        }
        guard let id = packet["id"], !(id is NSNull) else { return }
        guard let method = packet["method"] as? String else { return }
        let args: [Any]
        if let present = packet["args"] {
            guard let array = present as? [Any] else { return }
            args = array
        } else {
            args = []
        }
        ioQueue.async {
            let result = self.dispatcher.dispatch(method, args: args)
            let json = Self.encode(result)
            DispatchQueue.main.async { self.reply(id, json) }
        }
    }

    func barrier(_ work: @escaping () -> Void) {
        ioQueue.async(flags: .barrier) {
            DispatchQueue.main.async(execute: work)
        }
    }

    // MARK: - 应答脚本（id 与 json 都经 JSON 字面量编码，杜绝脚本注入）

    static func replyScript(id: Any, json: String) -> String {
        let idLiteral = jsLiteral(id)
        return "globalThis.__dshBridgeResolve(\(idLiteral), \(json));"
    }

    static func encode(_ map: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: map))
            ?? Data(#"{"ok":false,"error":"应答序列化失败"}"#.utf8)
        return String(data: data, encoding: .utf8) ?? #"{"ok":false,"error":"应答序列化失败"}"#
    }

    private static func jsLiteral(_ value: Any) -> String {
        if let n = value as? NSNumber {
            if CFGetTypeID(n) == CFBooleanGetTypeID() {
                return n.boolValue ? "true" : "false"
            }
            return n.stringValue
        }
        if value is NSNull { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: value,
                                                  options: [.fragmentsAllowed]),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return "null"
    }
}
