import XCTest
@testable import DSHRemote

final class ShellAssetRoutesTests: XCTestCase {
    /// 测试 target 把 ShellAssets 作为 resources 打入（见 project.yml）。
    private func bundleLoad(_ name: String) -> Data? {
        let bundle = Bundle(for: BundleMarker.self)
        guard let url = bundle.url(forResource: name, withExtension: nil) else { return nil }
        return try? Data(contentsOf: url)
    }

    private func makeRoutes() -> ShellAssetRoutes {
        ShellAssetRoutes(loadData: { [weak self] name in
            self?.bundleLoad(name)
        })
    }

    func testAll18AssetsReturn200WithContentTypeAndNoStore() throws {
        let routes = makeRoutes()
        for name in AssetManifest.names {
            let raw = try XCTUnwrap(routes.respond(method: "GET",
                                                   target: "/__shell__/\(name)"),
                                    "\(name) 未命中本地路由")
            let resp = try parseResponse(raw)
            XCTAssertEqual(resp.status, 200, "\(name) 状态码")
            XCTAssertEqual(resp.head.header("content-type"),
                           AssetManifest.contentType(name), "\(name) content-type")
            XCTAssertEqual(resp.head.header("cache-control"), "no-store", "\(name) no-store")
            XCTAssertEqual(Int(resp.head.header("content-length") ?? ""),
                           resp.body.count, "\(name) content-length")
            let expected = try XCTUnwrap(bundleLoad(name))
            XCTAssertEqual(resp.body, expected, "\(name) 字节一致")
        }
    }

    func testPathTraversalAndUnknownNamesAre404() throws {
        let routes = makeRoutes()
        for target in [
            "/__shell__/../AssetManifest.swift",
            "/__shell__/..%2f..%2fsecret",
            "/__shell__/sub/ipad.js",
            "/__shell__/does-not-exist.js",
            "/__shell__/",
            "/__shell__/.",
            "/__shell__/.."
        ] {
            guard let raw = routes.respond(method: "GET", target: target) else {
                return XCTFail("\(target) 应命中本地路由")
            }
            let resp = try parseResponse(raw)
            XCTAssertEqual(resp.status, 404, "\(target) 应 404")
        }
    }

    func testNonShellTargetReturnsNilForUpstream() {
        let routes = makeRoutes()
        XCTAssertNil(routes.respond(method: "GET", target: "/writing-studio/api/ping"))
        XCTAssertNil(routes.respond(method: "POST", target: "/app#/"))
    }

    func testShellHtmlIsInjected() throws {
        let routes = makeRoutes()
        let raw = try XCTUnwrap(routes.respond(method: "GET", target: "/__shell__/shell.html"))
        let resp = try parseResponse(raw)
        XCTAssertEqual(resp.status, 200)
        XCTAssertEqual(resp.head.header("content-type"), "text/html; charset=utf-8")
        let html = String(decoding: resp.body, as: UTF8.self)
        XCTAssertTrue(html.contains(ShellHTMLInjector.cssInsertion))
        XCTAssertTrue(html.contains(ShellHTMLInjector.jsInsertion))
    }

    func testPingReturnsJson() throws {
        let routes = makeRoutes()
        let raw = try XCTUnwrap(routes.respond(method: "GET", target: "/__shell__/ping"))
        let resp = try parseResponse(raw)
        XCTAssertEqual(resp.status, 200)
        XCTAssertTrue(String(decoding: resp.body, as: UTF8.self).contains("pong"))
    }

    func testHeadHasNoBody() throws {
        let routes = makeRoutes()
        let raw = try XCTUnwrap(routes.respond(method: "HEAD", target: "/__shell__/ipad.css"))
        let resp = try parseResponse(raw)
        XCTAssertEqual(resp.status, 200)
        XCTAssertTrue(resp.body.isEmpty)
        XCTAssertNotEqual(Int(resp.head.header("content-length") ?? ""), 0)
    }

    func testPostIs405() throws {
        let routes = makeRoutes()
        let raw = try XCTUnwrap(routes.respond(method: "POST", target: "/__shell__/ping"))
        XCTAssertEqual(try parseResponse(raw).status, 405)
    }

    // MARK: - 最小响应解析（测试辅助）

    private func parseResponse(_ raw: Data) throws -> ParsedResponse {
        let end = try XCTUnwrap(HTTPHeadCodec.headerEndIndex(in: raw))
        let headBytes = raw.prefix(end - HTTPHeadCodec.headerEnd.count)
        let head = try HTTPHeadCodec.parseResponse(Data(headBytes))
        return ParsedResponse(head: head, body: Data(raw.suffix(from: end)),
                              status: head.status)
    }
}

private struct ParsedResponse {
    let head: HTTPResponseHead
    let body: Data
    let status: Int
}
