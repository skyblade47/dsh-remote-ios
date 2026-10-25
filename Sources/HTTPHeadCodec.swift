import Foundation

/// 方案 D / 4.4：HTTP/1.1 头部最小编解码（纯逻辑，模拟器可单测）。
///
/// 只处理头部：请求行/状态行 + 头字段，按 RFC 7230 裸字节切分。
/// 头之后的 body / chunked / 101 升级流全部交由 ByteBridge 逐字节透传，不在此解析。
enum HTTPHeadCodec {
    enum CodecError: Error, Equatable {
        case malformedHead
        case unsupportedVersion
        case headerTooLarge
        case disconnected
        case prematureEOF
    }

    static let headerEnd = Data([0x0d, 0x0a, 0x0d, 0x0a])
    static let headerLimit = 64 * 1024

    /// RFC 7230 §6.1 hop-by-hop 头（外加 proxy 系列），转发时一律剥离。
    static let hopByHop: Set<String> = [
        "connection", "keep-alive", "proxy-authenticate",
        "proxy-authorization", "te", "trailer",
        "transfer-encoding", "upgrade"
    ]
}

// 不声明 Equatable：headers 为 named-tuple 数组，Swift 不会为此类存储属性自动合成。
struct HTTPRequestHead {
    var method: String
    /// 原始 target：origin-form（`/path?q=1`）或 authority-form；localhost 代理对客户端原样转发。
    var target: String
    var headers: [(name: String, value: String)]

    func header(_ name: String) -> String? {
        let want = name.lowercased()
        return headers.first(where: { $0.name.lowercased() == want })?.value
    }

    func isWebSocketUpgrade() -> Bool {
        guard header("upgrade")?.lowercased().contains("websocket") == true else { return false }
        guard let conn = header("connection")?.lowercased() else { return false }
        return conn.split(separator: ",").contains { $0.trimmingCharacters(in: .whitespaces) == "upgrade" }
    }
}

struct HTTPResponseHead {
    var status: Int
    var reason: String
    var headers: [(name: String, value: String)]

    func header(_ name: String) -> String? {
        let want = name.lowercased()
        return headers.first(where: { $0.name.lowercased() == want })?.value
    }
}

extension HTTPHeadCodec {
    /// 在累积缓冲区中定位头部结束位置，返回 CRLFCRLF 之后的起始 index（未找到返回 nil）。
    static func headerEndIndex(in data: Data) -> Int? {
        guard let range = data.range(of: headerEnd) else { return nil }
        return range.upperBound
    }

    /// 解析请求头字节（不含 CRLFCRLF 之后内容）。
    static func parseRequest(_ raw: Data) throws -> HTTPRequestHead {
        let text = String(decoding: raw, as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        guard let requestLine = lines.first, !requestLine.isEmpty else {
            throw CodecError.malformedHead
        }
        let parts = requestLine.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
            .map(String.init)
        guard parts.count == 3 else { throw CodecError.malformedHead }
        guard parts[2] == "HTTP/1.1" || parts[2] == "HTTP/1.0" else {
            throw CodecError.unsupportedVersion
        }
        lines.removeFirst()
        return HTTPRequestHead(method: parts[0], target: parts[1],
                               headers: try parseHeaderLines(lines))
    }

    /// 解析响应头字节（不含 CRLFCRLF 之后内容）。
    static func parseResponse(_ raw: Data) throws -> HTTPResponseHead {
        let text = String(decoding: raw, as: UTF8.self)
        var lines = text.components(separatedBy: "\r\n")
        guard let statusLine = lines.first, !statusLine.isEmpty else {
            throw CodecError.malformedHead
        }
        let parts = statusLine.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
            .map(String.init)
        guard parts.count >= 2, parts[0] == "HTTP/1.1" || parts[0] == "HTTP/1.0",
              let status = Int(parts[1]) else {
            throw CodecError.malformedHead
        }
        let reason = parts.count == 3 ? parts[2] : ""
        lines.removeFirst()
        return HTTPResponseHead(status: status, reason: reason,
                                headers: try parseHeaderLines(lines))
    }

    private static func parseHeaderLines(_ lines: [String]) throws -> [(String, String)] {
        var result: [(String, String)] = []
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { throw CodecError.malformedHead }
            let name = String(line[line.startIndex..<colon])
            let value = String(line[line.index(after: colon)...])
                .trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { throw CodecError.malformedHead }
            result.append((name, value))
        }
        return result
    }

    /// 序列化转发给上游的请求：剥离 hop-by-hop，Host 重写为上游，WS 升级时显式带 Connection: Upgrade。
    static func serializeUpstreamRequest(_ head: HTTPRequestHead, upstreamHost: String) -> Data {
        var kept: [(String, String)] = []
        for (name, value) in head.headers where !hopByHop.contains(name.lowercased()) {
            kept.append((name, value))
        }
        kept.append(("Host", upstreamHost))
        if head.isWebSocketUpgrade() {
            kept.append(("Connection", "Upgrade"))
            kept.append(("Upgrade", "websocket"))
        }
        var out = "\(head.method) \(head.target) HTTP/1.1\r\n"
        for (name, value) in kept {
            out += "\(name): \(value)\r\n"
        }
        out += "\r\n"
        return Data(out.utf8)
    }

    /// 构造本地路由响应（HTTP/1.1，可带 body；HEAD 请求由调用方不发 body 处理）。
    static func serializeResponse(status: Int, reason: String,
                                  headers: [(String, String)]) -> Data {
        var out = "HTTP/1.1 \(status) \(reason)\r\n"
        for (name, value) in headers {
            out += "\(name): \(value)\r\n"
        }
        out += "\r\n"
        return Data(out.utf8)
    }

    /// 节点离线 / 拒连时的友好 502 响应。
    static func badGateway() -> Data {
        let body = Data(
            """
            <!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>DSH 节点不可达</title></head>
            <body style="font-family:-apple-system,sans-serif;padding:24px;">
            <h2>DSH tailnet 节点暂时不可达</h2>
            <p>请确认 iPad 已加入 tailnet、对端节点在线后重试。</p>
            </body></html>
            """.utf8)
        return serializeResponse(status: 502, reason: "Bad Gateway", headers: [
            ("Content-Type", "text/html; charset=utf-8"),
            ("Content-Length", "\(body.count)"),
            ("Cache-Control", "no-store"),
            ("Connection", "close")
        ]) + body
    }
}
