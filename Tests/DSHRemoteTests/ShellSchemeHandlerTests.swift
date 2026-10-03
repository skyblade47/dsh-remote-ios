import XCTest
import WebKit
@testable import DSHRemote

final class ShellSchemeHandlerTests: XCTestCase {
    private final class FakeTask: NSObject, WKURLSchemeTask {
        let request: URLRequest
        var received: (URLResponse, Data)?
        var didStop = false
        init(_ url: URL) { self.request = URLRequest(url: url) }
        func didReceive(_ response: URLResponse) {
            received = (response, received?.1 ?? Data())
        }
        func didReceive(_ data: Data) {
            received = (received?.0 ?? URLResponse(),
                        (received?.1 ?? Data()) + data)
        }
        func didFinish() { didStop = true }
        func didFailWithError(_ error: Error) {}
    }

    func testPingReturnsFixedJSON() throws {
        let h = ShellSchemeHandler(loadData: { _ in nil })
        let t = FakeTask(URL(string: "dsh-asset://local/ping")!)
        h.webView(WKWebView(), start: t)
        let (resp, data) = try XCTUnwrap(t.received)
        let http = try XCTUnwrap(resp as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertEqual(obj?["echo"] as? String, "pong")
        XCTAssertTrue(t.didStop)
    }

    func testWhitelistedAssetServed() {
        let h = ShellSchemeHandler(loadData: { name in
            name == "writing.js" ? Data("//js".utf8) : nil
        })
        let t = FakeTask(URL(string: "dsh-asset://local/writing.js")!)
        h.webView(WKWebView(), start: t)
        XCTAssertEqual(t.received?.1, Data("//js".utf8))
    }

    func testUnknownReturns404() {
        let h = ShellSchemeHandler(loadData: { _ in nil })
        let t = FakeTask(URL(string: "dsh-asset://local/evil.js")!)
        h.webView(WKWebView(), start: t)
        let http = t.received?.0 as? HTTPURLResponse
        XCTAssertEqual(http?.statusCode, 404)
    }
}
