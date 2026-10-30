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

        // S1 自检页：由反代本地下发，走真实 HTTP 导航（与产品壳完全同一条路径）。
        // 历史教训：用 loadHTMLString(html, baseURL: loopback) 装载探针页时，WKWebView
        // 对该文档的子资源/ fetch 请求行为不可靠（同一 URL 时而 200 时而空 404 且不进
        // listener；真实导航文档则 100% 正常，见真机 18 件壳资产与 /app 文档体）。
        // 因此探针页改为普通本地路由资源。
        var head = parsed.head
        head.target = HTTPHeadCodec.normalizedTarget(head.target)
        let probePath = head.target.split(separator: "?", maxSplits: 1,
                                          omittingEmptySubsequences: false).first.map(String.init) ?? ""
        if head.method == "GET", probePath == Self.s1ProbePath {
            try? await client.write(Self.s1ProbeResponse())
            await client.close()
            return
        }

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

    /// S1 自检页的本地路径（不加 `__shell__` 前缀，避免与白名单资产混在一起）。
    static let s1ProbePath = "/__s1__/probe"

    /// S1 自检页应答：真实 HTTP 文档（text/html），与产品壳相同的加载方式。
    private static func s1ProbeResponse() -> Data {
        let body = Data(S1ProbePage.html(loopbackOrigin: "").utf8)
        let h = HTTPHeadCodec.serializeResponse(status: 200, reason: "OK", headers: [
            ("Content-Type", "text/html; charset=utf-8"),
            ("Content-Length", "\(body.count)"),
            ("Cache-Control", "no-store"),
            ("Connection", "close")
        ])
        return h + body
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
