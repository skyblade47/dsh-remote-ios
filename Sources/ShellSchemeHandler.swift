import Foundation
import WebKit

final class ShellSchemeHandler: NSObject, WKURLSchemeHandler {
    private let loadData: (String) -> Data?

    init(loadData: @escaping (String) -> Data?) {
        self.loadData = loadData
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url
        let host = url?.host ?? ""
        let name = url?.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")) ?? ""

        if host == "local" && name == "ping" {
            respond(urlSchemeTask, status: 200, contentType: "application/json; charset=utf-8",
                    body: Data("{\"ok\":true,\"echo\":\"pong\"}".utf8))
            return
        }

        guard host == "local", AssetManifest.isAsset(name), let data = loadData(name) else {
            respond(urlSchemeTask, status: 404, contentType: "application/json; charset=utf-8",
                    body: Data("{\"ok\":false,\"error\":\"not-found\"}".utf8))
            return
        }
        respond(urlSchemeTask, status: 200, contentType: AssetManifest.contentType(name), body: data)
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}

    private func respond(_ task: WKURLSchemeTask, status: Int, contentType: String, body: Data) {
        guard let url = task.request.url else { fail(task); return }
        let headers: [String: String] = [
            "Content-Type": contentType,
            "Content-Length": "\(body.count)",
            "Access-Control-Allow-Origin": "*"
        ]
        guard let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
        ) else { fail(task); return }
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    private func fail(_ task: WKURLSchemeTask) {
        task.didFailWithError(NSError(domain: "dsh-asset", code: -1))
    }
}
