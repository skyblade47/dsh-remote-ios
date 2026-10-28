import XCTest
@testable import DSHRemote

final class HTTPHeadCodecTests: XCTestCase {
    func testParseRequest() throws {
        let raw = Data(
            "GET /writing-studio/api/ping?x=1 HTTP/1.1\r\nHost: h\r\nCookie: a=1\r\n\r\n".utf8)
        let head = try HTTPHeadCodec.parseRequest(raw)
        XCTAssertEqual(head.method, "GET")
        XCTAssertEqual(head.target, "/writing-studio/api/ping?x=1")
        XCTAssertEqual(head.header("COOKIE"), "a=1")
    }

    func testNormalizedTargetAbsoluteForm() {
        // loadHTMLString 文档内 XHR 的 absolute-form（真机实测）→ origin-form
        XCTAssertEqual(
            HTTPHeadCodec.normalizedTarget("http://127.0.0.1:8080/__shell__/ping"),
            "/__shell__/ping")
        XCTAssertEqual(
            HTTPHeadCodec.normalizedTarget("http://127.0.0.1:8080/auth/login?u=1"),
            "/auth/login?u=1")
        // 无 path 归一为 "/"；fragment 必须丢弃（不随请求发送）
        XCTAssertEqual(
            HTTPHeadCodec.normalizedTarget("http://127.0.0.1:8080#frag"), "/")
        // origin-form / CONNECT authority-form 原样
        XCTAssertEqual(HTTPHeadCodec.normalizedTarget("/app#/"), "/app#/")
        XCTAssertEqual(HTTPHeadCodec.normalizedTarget("100.99.84.35:8080"), "100.99.84.35:8080")
    }

    func testMalformedAndVersionRejected() {
        XCTAssertThrowsError(try HTTPHeadCodec.parseRequest(Data("GARBAGE\r\n\r\n".utf8))) {
            XCTAssertEqual($0 as? HTTPHeadCodec.CodecError, .malformedHead)
        }
        XCTAssertThrowsError(
            try HTTPHeadCodec.parseRequest(Data("GET / HTTP/2.0\r\n\r\n".utf8))
        ) {
            XCTAssertEqual($0 as? HTTPHeadCodec.CodecError, .unsupportedVersion)
        }
        XCTAssertThrowsError(
            try HTTPHeadCodec.parseRequest(Data("GET /\r\n\r\n".utf8))
        )
    }

    func testHeaderEndIndex() {
        // "a\r\nb\r\n\r\n" 共 8 字节，upperBound 指向下一字节（TAIL 的 T）。
        let data = Data("a\r\nb\r\n\r\nTAIL".utf8)
        XCTAssertEqual(HTTPHeadCodec.headerEndIndex(in: data), 8)
        XCTAssertNil(HTTPHeadCodec.headerEndIndex(in: Data("no head end".utf8)))
    }

    func testWebSocketUpgradeDetection() throws {
        let ws = try HTTPHeadCodec.parseRequest(Data(
            "GET /ws HTTP/1.1\r\nConnection: keep-alive, Upgrade\r\nUpgrade: WebSocket\r\n\r\n".utf8))
        XCTAssertTrue(ws.isWebSocketUpgrade())
        let plain = try HTTPHeadCodec.parseRequest(Data(
            "GET /ws HTTP/1.1\r\nConnection: keep-alive\r\n\r\n".utf8))
        XCTAssertFalse(plain.isWebSocketUpgrade())
    }

    func testUpstreamSerializationRewritesHostAndStripsHopHeaders() throws {
        let head = try HTTPHeadCodec.parseRequest(Data(
            "POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:54321\r\nConnection: keep-alive\r\nProxy-Authorization: Bearer x\r\nContent-Length: 4\r\nCookie: c=1\r\n\r\n".utf8))
        let out = HTTPHeadCodec.serializeUpstreamRequest(head, upstreamHost: "100.99.84.35:8080")
        let text = String(decoding: out, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("POST /api/x HTTP/1.1\r\n"))
        XCTAssertTrue(text.contains("Host: 100.99.84.35:8080\r\n"))
        XCTAssertTrue(text.contains("Content-Length: 4\r\n"))
        XCTAssertTrue(text.contains("Cookie: c=1\r\n"))
        XCTAssertFalse(text.lowercased().contains("connection:"))
        XCTAssertFalse(text.lowercased().contains("proxy-authorization"))
    }

    func testUpstreamSerializationKeepsUpgradeTokens() throws {
        let head = try HTTPHeadCodec.parseRequest(Data(
            "GET /ws HTTP/1.1\r\nHost: local\r\nConnection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: k\r\n\r\n".utf8))
        let out = String(decoding: HTTPHeadCodec.serializeUpstreamRequest(
            head, upstreamHost: "100.99.84.35:8080"), as: UTF8.self)
        XCTAssertTrue(out.contains("Connection: Upgrade\r\n"))
        XCTAssertTrue(out.contains("Upgrade: websocket\r\n"))
        XCTAssertTrue(out.contains("Sec-WebSocket-Key: k\r\n"))
    }

    func testBadGatewayIs502() throws {
        let raw = HTTPHeadCodec.badGateway()
        let end = try XCTUnwrap(HTTPHeadCodec.headerEndIndex(in: raw))
        let head = try HTTPHeadCodec.parseResponse(
            raw.prefix(end - HTTPHeadCodec.headerEnd.count))
        XCTAssertEqual(head.status, 502)
    }
}
