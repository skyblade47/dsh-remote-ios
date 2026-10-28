import XCTest
@testable import DSHRemote

final class HttpBridgeTests: XCTestCase {

    // MARK: - 普通 API 往返 + 头透传

    func testApiRoundTripForwardsMethodTargetCookieAndResponseHeaders() async throws {
        let connecter = FakeConnecter(mode: .jsonEcho)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()

        await session.run(bridge)
        try await session.writeString(
            "GET /writing-studio/api/clientZone?id=42 HTTP/1.1\r\n" +
            "Host: 127.0.0.1:0\r\nCookie: sid=abc\r\nConnection: close\r\n\r\n")

        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 200)
        XCTAssertEqual(resp.head.header("set-cookie"), "dsh=1; Path=/")
        XCTAssertEqual(resp.head.header("x-test-upstream"), "fake")
        // JSON 值含 Bool，字典须按 [String: Any] 桥接。
        let json = try JSONSerialization.jsonObject(with: resp.body) as? [String: Any]
        XCTAssertEqual(json?["method"] as? String, "GET")
        XCTAssertEqual(json?["target"] as? String, "/writing-studio/api/clientZone?id=42")
        XCTAssertEqual(json?["cookie"] as? String, "sid=abc")

        let rec = await connecter.recorder.calls
        XCTAssertEqual(rec.count, 1)
        XCTAssertEqual(rec[0].head.method, "GET")
        XCTAssertTrue(rec[0].head.header("host")?.hasPrefix("100.99.84.35:8080") == true)
        // hop-by-hop 不得透传
        XCTAssertNil(rec[0].head.header("connection"))
        await session.finish()
    }

    // MARK: - POST body 透传

    func testPostBodyForwardedByteForByte() async throws {
        let connecter = FakeConnecter(mode: .jsonEcho)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()
        let payload = Data((0..<150_000).map { UInt8($0 & 0xff) })

        await session.run(bridge)
        try await session.writeString(
            "POST /writing-studio/api/clientZoneSave HTTP/1.1\r\n" +
            "Host: 127.0.0.1:0\r\nContent-Length: \(payload.count)\r\n\r\n")
        try await session.write(payload)

        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 200)

        // 等假上游把记录落盘
        try await waitUntil(2_000) { await connecter.recorder.calls.first?.body.count == payload.count }
        let rec = await connecter.recorder.calls
        XCTAssertEqual(rec[0].body, payload)
        await session.finish()
    }

    // MARK: - 大响应流式

    func testLargeResponseStreamedByteForByte() async throws {
        let total = 1_500_000
        let connecter = FakeConnecter(mode: .largeResponse(total))
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()

        await session.run(bridge)
        try await session.writeString("GET /dl HTTP/1.1\r\nHost: x\r\n\r\n")

        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 200)
        XCTAssertEqual(Int(resp.head.header("content-length") ?? ""), total)
        // readResponse 按 Content-Length 流式收齐，不依赖整体缓冲之外的语义
        XCTAssertEqual(resp.body.count, total)
        // 确定性 pattern 抽样校验（首、中段、末段）
        XCTAssertEqual(resp.body[0], 0)
        XCTAssertEqual(resp.body[777_777], UInt8(777_777 & 0xff))
        XCTAssertEqual(resp.body[total - 1], UInt8((total - 1) & 0xff))
        await session.finish()
    }

    // MARK: - WebSocket 101 后裸字节双向

    func testWebSocketUpgradeAndRawBidirectionalBytes() async throws {
        let connecter = FakeConnecter(mode: .webSocket)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()

        await session.run(bridge)
        try await session.writeString(
            "GET /ws HTTP/1.1\r\nHost: x\r\nConnection: keep-alive, Upgrade\r\n" +
            "Upgrade: websocket\r\nSec-WebSocket-Key: k\r\n\r\n")

        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 101)
        XCTAssertEqual(resp.head.header("upgrade"), "websocket")

        for i in 0..<5 {
            let frame = Data([0x81, UInt8(i), 0xaa, 0xbb])
            try await session.write(frame)
            let echoed = try await session.readExact(frame.count, timeoutMs: 3_000)
            XCTAssertEqual(echoed, frame, "第 \(i) 帧 echo 不一致")
        }
        await session.finish()
    }

    // MARK: - 上游拒连 502

    func testUpstreamRefusedReturnsFriendly502() async throws {
        let connecter = FakeConnecter(failing: true)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()

        await session.run(bridge)
        try await session.writeString("GET /api/x HTTP/1.1\r\nHost: x\r\n\r\n")
        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 502)
        XCTAssertTrue(String(decoding: resp.body, as: UTF8.self).contains("tailnet"))
        await session.finish()
    }

    // MARK: - 壳资产经 HttpBridge 本地应答

    func testShellAssetServedLocallyWithoutUpstream() async throws {
        let connecter = FakeConnecter(mode: .jsonEcho)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()

        await session.run(bridge)
        try await session.writeString("GET /__shell__/ping HTTP/1.1\r\nHost: x\r\n\r\n")
        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 200)
        XCTAssertTrue(String(decoding: resp.body, as: UTF8.self).contains("pong"))
        XCTAssertEqual(connecter.connectCount, 0, "本地路由不得拨上游")
        await session.finish()
    }

    func testAbsoluteFormShellAssetServedLocally() async throws {
        // loadHTMLString 文档内 XHR 的 absolute-form 请求行（真机复现）：归一后命中本地路由。
        let connecter = FakeConnecter(mode: .jsonEcho)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()

        await session.run(bridge)
        try await session.writeString(
            "GET http://127.0.0.1:0/__shell__/ping HTTP/1.1\r\nHost: 127.0.0.1:0\r\n\r\n")
        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 200)
        XCTAssertTrue(String(decoding: resp.body, as: UTF8.self).contains("pong"))
        XCTAssertEqual(connecter.connectCount, 0, "absolute-form 本地资源不得拨上游")
        await session.finish()
    }

    func testAbsoluteFormApiNormalizedBeforeUpstream() async throws {
        // absolute-form 的 API 请求：透传前 target 必须归一为 origin-form（不把 loopback authority 带上）。
        let connecter = FakeConnecter(mode: .jsonEcho)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()

        await session.run(bridge)
        try await session.writeString(
            "GET http://127.0.0.1:0/writing-studio/api/clientZone?id=7 HTTP/1.1\r\nHost: 127.0.0.1:0\r\n\r\n")
        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 200)
        let rec = await connecter.recorder.calls
        XCTAssertEqual(rec[0].head.target, "/writing-studio/api/clientZone?id=7")
        await session.finish()
    }

    func testDiagEchoesRawRequestTarget() async throws {
        // 临时诊断端点：origin-form 与 absolute-form 都要被本地拦截并回显原始 target。
        for target in ["/__shell__/diag?t=1", "http://127.0.0.1:0/__shell__/diag?t=1"] {
            let connecter = FakeConnecter(mode: .jsonEcho)
            let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
            let session = ClientSession()
            await session.run(bridge)
            try await session.writeString(
                "GET \(target) HTTP/1.1\r\nHost: 127.0.0.1:0\r\n\r\n")
            let resp = try await session.readResponse()
            XCTAssertEqual(resp.status, 200, "target=\(target)")
            let body = String(decoding: resp.body, as: UTF8.self)
            XCTAssertTrue(body.contains("\"diag\":true"), body)
            XCTAssertTrue(body.contains("\"rawTarget\":\"\(target)\""), body)
            let connects = connecter.connectCount
            XCTAssertEqual(connects, 0, "diag 不得拨上游")
            await session.finish()
        }
    }

    func testDiagLogRingRecordsReachedRequestsAndClears() async throws {
        // DIAG-D 临时端点：清空环 → 打一发本地 ping → /diag-log 必须在环内看到该 raw target。
        // HttpBridge 每条连接应答完即关，故三次请求各用独立 ClientSession（共享同一 ring/connecter）。
        let connecter = FakeConnecter(mode: .jsonEcho)
        func oneShot(_ target: String) async throws -> ClientSession.Response {
            let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
            let session = ClientSession()
            await session.run(bridge)
            try await session.writeString("GET \(target) HTTP/1.1\r\nHost: x\r\n\r\n")
            let resp = try await session.readResponse()
            await session.finish()
            return resp
        }

        _ = try await oneShot("/diag-log?clear=1")
        _ = try await oneShot("/__shell__/ping")
        let resp = try await oneShot("/diag-log?read=1")
        XCTAssertEqual(resp.status, 200)
        let body = String(decoding: resp.body, as: UTF8.self)
        XCTAssertTrue(body.contains("/__shell__/ping"), body)
        XCTAssertEqual(connecter.connectCount, 0)
    }

    func testMalformedRequestReturns400() async throws {
        let connecter = FakeConnecter(mode: .jsonEcho)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let session = ClientSession()

        await session.run(bridge)
        try await session.writeString("GARBAGE NOT HTTP\r\n\r\n")
        let resp = try await session.readResponse()
        XCTAssertEqual(resp.status, 400)
        await session.finish()
    }

    // MARK: - helpers

    private func makeRoutes() -> ShellAssetRoutes {
        ShellAssetRoutes { name in
            let bundle = Bundle(for: BundleMarker.self)
            guard let url = bundle.url(forResource: name, withExtension: nil) else { return nil }
            return try? Data(contentsOf: url)
        }
    }

    private func waitUntil(_ timeoutMs: UInt64, _ condition: @escaping () async -> Bool) async throws {
        let deadline = ContinuousClock().now.advanced(by: .milliseconds(timeoutMs))
        while await !condition() {
            if ContinuousClock().now >= deadline {
                throw NSError(domain: "HttpBridgeTests", code: 99,
                              userInfo: [NSLocalizedDescriptionKey: "条件等待超时"])
            }
            try await Task.sleep(nanoseconds: 30_000_000)
        }
    }
}

/// 测试客户端：HttpBridge 的对端通道 + 最小读写/响应解析。
private final class ClientSession {
    private let (app, proxy) = InMemoryChannel.makePair()
    private var buffer = Data()
    private var task: Task<Void, Never>?

    struct Response {
        let head: HTTPResponseHead
        let status: Int
        let body: Data
    }

    func run(_ bridge: HttpBridge) {
        let proxyChannel = proxy
        task = Task { await bridge.handle(proxyChannel) }
    }

    func writeString(_ s: String) async throws {
        try await app.write(Data(s.utf8))
    }

    func write(_ data: Data) async throws {
        try await app.write(data)
    }

    func readChunk(timeoutMs: UInt64 = 2_000) async throws -> Data? {
        try await withThrowingTaskGroup(of: Data?.self) { group in
            group.addTask { [app] in try await app.read() }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
                return Optional<Data>.none as Data?
            }
            let v = try await group.next()
            group.cancelAll()
            return v ?? nil
        }
    }

    func readExact(_ n: Int, timeoutMs: UInt64) async throws -> Data {
        var out = Data()
        while out.count < n {
            guard let chunk = try await readChunk(timeoutMs: timeoutMs) else {
                throw NSError(domain: "ClientSession", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "期望 \(n) 字节，提前 EOF（已读 \(out.count)）"
                ])
            }
            out.append(chunk)
        }
        return out.prefix(n)
    }

    func readResponse() async throws -> Response {
        var end: Int?
        while true {
            if let idx = HTTPHeadCodec.headerEndIndex(in: buffer) { end = idx; break }
            guard let chunk = try await readChunk(timeoutMs: 3_000) else {
                throw NSError(domain: "ClientSession", code: 4,
                              userInfo: [NSLocalizedDescriptionKey: "等响应头时 EOF"])
            }
            buffer.append(chunk)
        }
        let idx = end!
        let headBytes = buffer.prefix(idx - HTTPHeadCodec.headerEnd.count)
        let head = try HTTPHeadCodec.parseResponse(Data(headBytes))

        let declared = Int(head.header("content-length") ?? "")
        var body = Data(buffer.suffix(from: idx))
        while let need = declared, body.count < need, head.status != 101 {
            guard let chunk = try await readChunk(timeoutMs: 3_000) else { break }
            body.append(chunk)
        }
        let finalBody: Data
        if let need = declared, head.status != 101 {
            finalBody = Data(body.prefix(need))
        } else {
            finalBody = body
        }
        buffer = Data()
        return Response(head: head, status: head.status, body: finalBody)
    }

    func finish() async {
        await app.close()
        _ = await task?.result
    }
}
