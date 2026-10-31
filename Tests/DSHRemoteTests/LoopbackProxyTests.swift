import Foundation
import Network
import XCTest
@testable import DSHRemote

/// Phase 4.5：真实 loopback TCP 栈闭环——NWListener → NWConnectionChannel → HttpBridge
/// → 注入的 FakeConnecter（上游仍是内存假服务）。不经真 tailnet。
final class LoopbackProxyTests: XCTestCase {

    // MARK: - 真实 TCP 往返：API 经反代到假上游

    func testApiRoundTripOverRealLoopbackTCP() async throws {
        let connecter = FakeConnecter(mode: .jsonEcho)
        let started = try await startProxy(connecter: connecter)
        defer { started.proxy.stop() }

        let request = Data(
            "GET /writing-studio/api/ping HTTP/1.1\r\nCookie: sid=abc\r\n\r\n".utf8)

        let response = try await roundTrip(to: started.base, request: request)
        XCTAssertEqual(response.status, 200)
        let json = try JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        XCTAssertEqual(json?["method"] as? String, "GET")
        XCTAssertEqual(json?["target"] as? String, "/writing-studio/api/ping")
        XCTAssertEqual(json?["cookie"] as? String, "sid=abc")
        XCTAssertEqual(response.headers.first { $0.name.lowercased() == "x-test-upstream" }?.value, "fake")

        // 经真实 TCP 到达的请求，Host 必须被重写为 tailnet 上游（非 127.0.0.1）。
        let rec = await connecter.recorder.calls
        XCTAssertEqual(rec.count, 1)
        let host = rec[0].head.header("host") ?? ""
        XCTAssertTrue(host.hasPrefix("100.99.84.35:8080"), "Host 实际为 \(host)")
    }

    // MARK: - 本地壳路由不经上游

    func testShellPingServedLocally() async throws {
        let connecter = FakeConnecter(mode: .jsonEcho)
        let started = try await startProxy(connecter: connecter)
        defer { started.proxy.stop() }

        let request = Data("GET /__shell__/ping HTTP/1.1\r\n\r\n".utf8)
        let response = try await roundTrip(to: started.base, request: request)

        XCTAssertEqual(response.status, 200)
        let json = try JSONSerialization.jsonObject(with: response.body) as? [String: Any]
        XCTAssertEqual(json?["echo"] as? String, "pong")
        XCTAssertEqual(connecter.connectCount, 0)
    }

    // MARK: - 上游拒连 → 502 友好页经真实 TCP 回到客户端

    func testUpstreamUnavailableReturns502() async throws {
        let connecter = FakeConnecter(failing: true)
        let started = try await startProxy(connecter: connecter)
        defer { started.proxy.stop() }

        let request = Data("GET /api/x HTTP/1.1\r\n\r\n".utf8)
        let response = try await roundTrip(to: started.base, request: request)

        XCTAssertEqual(response.status, 502)
        XCTAssertTrue(String(decoding: response.body, as: UTF8.self).contains("tailnet"))
    }

    // MARK: - 动态端口与 UserDefaults 持久化

    func testDynamicPortPersistedToDefaults() async throws {
        let suite = "LoopbackProxyTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let routes = ShellAssetRoutes { _ in nil }
        let bridge = HttpBridge(routes: routes, connecter: FakeConnecter())
        let proxy = LoopbackProxy(bridge: bridge, defaults: defaults)
        let base = try await proxy.start()
        defer { proxy.stop() }

        XCTAssertEqual(base.host, "127.0.0.1")
        let port = try XCTUnwrap(base.port)
        XCTAssertGreaterThan(port, 0)
        XCTAssertEqual(defaults.string(forKey: LoopbackProxy.baseURLDefaultsKey),
                       "http://127.0.0.1:\(port)")
    }

    // MARK: 6.1 回前台探活：有监听且应答 → true；无监听 → false（不卡死、不假装活）

    func testProbeAliveTrueForServingBridgeAndFalseForClosedPort() async throws {
        let started = try await startProxy(connecter: FakeConnecter(mode: .jsonEcho))
        defer { started.proxy.stop() }

        let alive = await LoopbackProbe.isAlive(base: started.base.absoluteString)
        XCTAssertTrue(alive, "正在应答的桥必须探活成功")

        started.proxy.stop()
        try await Task.sleep(nanoseconds: 150_000_000)
        let dead = await LoopbackProbe.isAlive(base: started.base.absoluteString)
        XCTAssertFalse(dead, "listener 已回收（iOS 挂起场景）必须探活失败，触发重建")

        XCTAssertFalse(await LoopbackProbe.isAlive(base: "not-a-url"))
    }

    // MARK: 6.1 回前台重建：优先复用原端口（WKWebView 已装壳无需换 base 重载）

    func testRestartPrefersSamePortAndServesAgain() async throws {
        let suite = "LoopbackProxyTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        let connecter = FakeConnecter(mode: .jsonEcho)
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let proxy = LoopbackProxy(bridge: bridge, defaults: defaults)

        let first = try await proxy.start()
        let preferred = try XCTUnwrap(first.port)
        proxy.stop()
        // 等 listener 完全释放，再要求按原端口重建（对齐 2.6 真机 stop/start 355ms）。
        try await Task.sleep(nanoseconds: 150_000_000)

        let second = try await proxy.start(preferredPort: UInt16(preferred))
        defer { proxy.stop() }
        XCTAssertEqual(second.port, preferred, "原端口已释放时重建必须复用，壳无需换 base 重载")

        let request = Data("GET /__shell__/ping HTTP/1.1\r\n\r\n".utf8)
        let response = try await roundTrip(to: second, request: request)
        XCTAssertEqual(response.status, 200, "重建后的桥必须能正常应答")
    }

    func testRestartFallsBackToDynamicPortWhenPreferredBusy() async throws {
        let suite = "LoopbackProxyTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        // 占用方：持续监听一个动态端口不释放。
        let holderConnecter = FakeConnecter(mode: .jsonEcho)
        let holder = LoopbackProxy(
            bridge: HttpBridge(routes: ShellAssetRoutes { _ in nil }, connecter: holderConnecter),
            defaults: defaults)
        let holderBase = try await holder.start()
        let busyPort = UInt16(try XCTUnwrap(holderBase.port))
        defer { holder.stop() }

        // 重建方：要求占用中的端口，必须回退到另一个动态端口而非起桥失败。
        let connecter = FakeConnecter(mode: .jsonEcho)
        let proxy = LoopbackProxy(
            bridge: HttpBridge(routes: makeRoutes(), connecter: connecter), defaults: defaults)
        let rebound = try await proxy.start(preferredPort: busyPort)
        defer { proxy.stop() }
        XCTAssertNotEqual(rebound.port, Int(busyPort), "首选端口被占时必须回退动态端口")
        let request = Data("GET /__shell__/ping HTTP/1.1\r\n\r\n".utf8)
        let response = try await roundTrip(to: rebound, request: request)
        XCTAssertEqual(response.status, 200)
    }

    // MARK: - 流式大响应经真实 TCP 字节无损（300KB，跨多个 64KB 接收片）

    func testLargeStreamedResponseByteExact() async throws {
        let total = 300_000
        let connecter = FakeConnecter(mode: .largeResponse(total))
        let started = try await startProxy(connecter: connecter)
        defer { started.proxy.stop() }

        let request = Data("GET /big HTTP/1.1\r\n\r\n".utf8)
        let response = try await roundTrip(to: started.base, request: request)

        XCTAssertEqual(response.status, 200)
        XCTAssertEqual(response.body.count, total)
        for i in 0..<total {
            XCTAssertEqual(response.body[i], UInt8(i & 0xff), "字节 \(i) 不一致")
        }
    }

    // MARK: - helpers

    private func makeRoutes() -> ShellAssetRoutes {
        ShellAssetRoutes { name in
            let bundle = Bundle(for: BundleMarker.self)
            guard let url = bundle.url(forResource: name, withExtension: nil) else { return nil }
            return try? Data(contentsOf: url)
        }
    }

    private func startProxy(connecter: FakeConnecter)
    async throws -> (proxy: LoopbackProxy, base: URL) {
        let bridge = HttpBridge(routes: makeRoutes(), connecter: connecter)
        let suite = "LoopbackProxyTests.tmp.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let proxy = LoopbackProxy(bridge: bridge, defaults: defaults)
        let base = try await proxy.start()
        return (proxy, base)
    }

    /// 真实 TCP 客户端：开 NWConnection 发原始请求字节，收齐整响应（按 Content-Length）。
    private func roundTrip(to base: URL, request: Data)
    async throws -> (status: Int, headers: [(name: String, value: String)], body: Data) {
        let port = NWEndpoint.Port(rawValue: UInt16(try XCTUnwrap(base.port)))!
        let connection = NWConnection(
            host: NWEndpoint.Host("127.0.0.1"), port: port, using: .tcp)
        let channel = NWConnectionChannel(connection)
        channel.start()

        do {
            try await channel.write(request)

            var buffer = Data()
            var headEnd: Int?
            while headEnd == nil {
                guard let chunk = try await channel.read() else {
                    throw NSError(domain: "LoopbackProxyTests", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "响应头未收齐即 EOF"])
                }
                buffer.append(chunk)
                if let end = HTTPHeadCodec.headerEndIndex(in: buffer) {
                    headEnd = end
                }
            }

            let end = headEnd!
            let rawHead = buffer.prefix(end - HTTPHeadCodec.headerEnd.count)
            let head = try HTTPHeadCodec.parseResponse(Data(rawHead))
            let length = Int(head.header("content-length") ?? "0") ?? 0

            var body = buffer.suffix(from: end)
            while body.count < length {
                guard let chunk = try await channel.read() else { break }
                body.append(chunk)
            }
            await channel.close()
            return (head.status, head.headers, Data(body.prefix(length)))
        } catch {
            await channel.close()
            throw error
        }
    }
}
