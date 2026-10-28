import Foundation

/// 方案 D / 4.4：localhost 反代主循环（纯逻辑，模拟器可单测）。
///
/// 每条客户端连接：
/// 1. 读出 HTTP 请求头（64KB 上限）；
/// 2. `/__shell__/` 前缀走 ShellAssetRoutes 本地应答（应答完即关连接）；
/// 3. 其余请求经 UpstreamConnecter 拨到 tailnet 上游，剥离 hop-by-hop、
///    Host 重写后交由 ByteBridge 双向裸透传（覆盖 SSE 与 WS 101 之后的裸流）；
/// 4. 上游拒连 → 502 友好页。
///
/// 不做整响应缓冲、不设整体超时——流式是硬要求。
final class HttpBridge {
    private let routes: ShellAssetRoutes
    private let connecter: UpstreamConnecter
    private let upstreamHost: String
    private let upstreamPort: Int

    init(routes: ShellAssetRoutes,
         connecter: UpstreamConnecter,
         upstreamHost: String = "100.99.84.35",
         upstreamPort: Int = 8080) {
        self.routes = routes
        self.connecter = connecter
        self.upstreamHost = upstreamHost
        self.upstreamPort = upstreamPort
    }

    func handle(_ client: DuplexChannel) async {
        let parsed: (rawHead: Data, head: HTTPRequestHead, rest: Data)
        do {
            parsed = try await readHead(client)
        } catch HTTPHeadCodec.CodecError.disconnected {
            await client.close()
            return
        } catch {
            await writeError(status: 400, reason: "Bad Request", to: client)
            return
        }

        // WKWebView 在 loadHTMLString 文档内可能发 absolute-form 请求行（真机实测），
        // 统一归一为 origin-form 后再做本地路由分流与上游透传（见 normalizedTarget）。
        var head = parsed.head
        head.target = HTTPHeadCodec.normalizedTarget(head.target)

        // 路由分流：本地壳资源
        if head.target.hasPrefix(ShellAssetRoutes.prefix),
           let local = routes.respond(method: head.method, target: head.target) {
            try? await client.write(local)
            await client.close()
            return
        }

        // 其余全部桥接到 tailnet 上游
        let upstream: DuplexChannel
        do {
            upstream = try await connecter.connect(host: upstreamHost, port: upstreamPort)
        } catch {
            try? await client.write(HTTPHeadCodec.badGateway())
            await client.close()
            return
        }

        let requestBytes = HTTPHeadCodec.serializeUpstreamRequest(
            head, upstreamHost: "\(upstreamHost):\(upstreamPort)")
        await ByteBridge.run(client: client, upstream: upstream,
                             initialClientBytes: requestBytes + parsed.rest)
    }

    /// 读客户端请求头，返回「头原始字节（不含 CRLFCRLF）/ 解析结果 / 头部之后的首段 body」。
    private func readHead(_ client: DuplexChannel) async
    throws -> (rawHead: Data, head: HTTPRequestHead, rest: Data) {
        var buffer = Data()
        while true {
            if let end = HTTPHeadCodec.headerEndIndex(in: buffer) {
                let rawHead = buffer.prefix(end - HTTPHeadCodec.headerEnd.count)
                let rest = buffer.suffix(from: end)
                let head = try HTTPHeadCodec.parseRequest(Data(rawHead))
                return (Data(rawHead), head, Data(rest))
            }
            if buffer.count > HTTPHeadCodec.headerLimit {
                throw HTTPHeadCodec.CodecError.headerTooLarge
            }
            guard let chunk = try await client.read() else {
                throw buffer.isEmpty
                    ? HTTPHeadCodec.CodecError.disconnected
                    : HTTPHeadCodec.CodecError.prematureEOF
            }
            buffer.append(chunk)
        }
    }

    private func writeError(status: Int, reason: String, to client: DuplexChannel) async {
        let body = Data("{\"ok\":false,\"error\":\"\(reason.lowercased().replacingOccurrences(of: " ", with: "-"))\"}".utf8)
        let head = HTTPHeadCodec.serializeResponse(status: status, reason: reason, headers: [
            ("Content-Type", "application/json; charset=utf-8"),
            ("Content-Length", "\(body.count)"),
            ("Connection", "close")
        ])
        try? await client.write(head + body)
        await client.close()
    }
}
