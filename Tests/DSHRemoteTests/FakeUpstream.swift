import Foundation
@testable import DSHRemote

/// 假上游记录：请求行与头部、收到的全部 body 字节。
actor FakeUpstreamRecorder {
    private(set) var calls: [(head: HTTPRequestHead, body: Data)] = []

    func record(_ head: HTTPRequestHead, body: Data) {
        calls.append((head, body))
    }
}

/// 假上游行为：顶替 100.99.84.35:8080。
enum FakeUpstreamMode {
    /// 读完整请求（按 Content-Length），回显 JSON（method/target/关键头）+ Set-Cookie。
    case jsonEcho
    /// 流式回大响应：固定字节数分块写，不缓冲，模拟 SSE/下载。
    case largeResponse(Int)
    /// WebSocket 握手：回 101 后裸字节 echo，直到客户端 FIN。
    case webSocket
}

/// 假 UpstreamConnecter：connect 时建通道对，启动服务端 Task。
final class FakeConnecter: UpstreamConnecter {
    let recorder = FakeUpstreamRecorder()
    private let mode: FakeUpstreamMode
    private let failing: Bool
    private(set) var connectCount = 0
    private let countLock = NSLock()

    init(mode: FakeUpstreamMode = .jsonEcho, failing: Bool = false) {
        self.mode = mode
        self.failing = failing
    }

    func connect(host: String, port: Int) async throws -> DuplexChannel {
        countLock.lock()
        connectCount += 1
        countLock.unlock()
        if failing { throw BridgeError.upstreamConnectFailed }

        let (server, client) = InMemoryChannel.makePair()
        let mode = self.mode
        let recorder = self.recorder
        Task { await FakeConnecter.serve(server, mode: mode, recorder: recorder) }
        return client
    }

    private static func serve(_ server: InMemoryChannel,
                              mode: FakeUpstreamMode,
                              recorder: FakeUpstreamRecorder) async {
        guard let (head, rest) = try? await readHead(server) else {
            await server.close()
            return
        }
        let body = try? await readBody(server, head: head, initial: rest)
        await recorder.record(head, body: body ?? rest)

        switch mode {
        case .jsonEcho:
            await respondJSON(server, head: head)
        case .largeResponse(let total):
            await respondLarge(server, total: total)
        case .webSocket:
            await respondWebSocket(server)
        }
    }

    private static func readHead(_ server: InMemoryChannel)
    async throws -> (HTTPRequestHead, Data) {
        var buffer = Data()
        while true {
            if let end = HTTPHeadCodec.headerEndIndex(in: buffer) {
                let headEnd = end - HTTPHeadCodec.headerEnd.count
                let rawHead = buffer.prefix(headEnd)
                let rest = buffer.suffix(from: end)
                return (try HTTPHeadCodec.parseRequest(Data(rawHead)), Data(rest))
            }
            if buffer.count > HTTPHeadCodec.headerLimit {
                throw HTTPHeadCodec.CodecError.headerTooLarge
            }
            guard let chunk = try await server.read() else {
                throw HTTPHeadCodec.CodecError.prematureEOF
            }
            buffer.append(chunk)
        }
    }

    private static func readBody(_ server: InMemoryChannel,
                                 head: HTTPRequestHead, initial: Data) async throws -> Data {
        let length = Int(head.header("content-length") ?? "0") ?? 0
        var body = initial
        while body.count < length {
            guard let chunk = try await server.read() else { break }
            body.append(chunk)
        }
        return body
    }

    private static func respondJSON(_ server: InMemoryChannel, head: HTTPRequestHead) async {
        let cookie = (head.header("cookie") ?? "").replacingOccurrences(of: "\"", with: "'")
        let payload = """
        {"method":"\(head.method)","target":"\(head.target)","cookie":"\(cookie)","ok":true}
        """
        let body = Data(payload.utf8)
        let out = HTTPHeadCodec.serializeResponse(status: 200, reason: "OK", headers: [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", "\(body.count)"),
            ("Set-Cookie", "dsh=1; Path=/"),
            ("X-Test-Upstream", "fake"),
            ("Connection", "close")
        ]) + body
        try? await server.write(out)
        try? await Task.sleep(nanoseconds: 20_000_000)
        await server.close()
    }

    private static func respondLarge(_ server: InMemoryChannel, total: Int) async {
        var head = HTTPHeadCodec.serializeResponse(status: 200, reason: "OK", headers: [
            ("Content-Type", "application/octet-stream"),
            ("Content-Length", "\(total)"),
            ("Connection", "close")
        ])
        try? await server.write(head)

        var sent = 0
        while sent < total {
            let n = min(64 * 1024, total - sent)
            var chunk = Data(count: n)
            for i in 0..<n { chunk[i] = UInt8((sent + i) & 0xff) }
            try? await server.write(chunk)
            sent += n
        }
        try? await Task.sleep(nanoseconds: 20_000_000)
        await server.close()
    }

    private static func respondWebSocket(_ server: InMemoryChannel) async {
        let handshake = HTTPHeadCodec.serializeResponse(
            status: 101, reason: "Switching Protocols", headers: [
                ("Upgrade", "websocket"),
                ("Connection", "Upgrade")
            ])
        try? await server.write(handshake)
        // 101 之后裸字节 echo，直到客户端 FIN。
        while true {
            do {
                guard let chunk = try await server.read() else { break }
                if chunk.isEmpty { continue }
                try await server.write(chunk)
            } catch {
                break
            }
        }
        await server.close()
    }
}
