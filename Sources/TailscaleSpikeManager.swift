import Foundation
import SwiftUI
import Darwin
import TailscaleKit

// ============================================================================
// Phase 2.2/2.3 spike —— Tailscale 非交互入网 + 进程内 tailnet dial
// （**非产品代码，闸门 B 结论固化后删除**）
//
// 2.2：① auth key 非交互 up；② up 后取 tailnet IP；③ 杀进程靠 Documents/tailscale 恢复。
// 2.3：up 后经 C API tailscale_dial 拿一个可 read/write 的 conn fd，
//      手写 GET /auth/login 到 100.99.84.35:8080，证明进程内 tsnet 数据面真的通
//      （Swift 层 OutgoingConnection 只能 send 不能 receive，receive 在 iOS18+
//       独占的 IncomingConnection 上；2.3 目标是 iOS17，故走 C fd，2.4 本地桥也复用它）。
//
// 🔴 key 纪律：auth key 只存在于 SecureField 的内存 @State，调一次 up 后**立即清空**，
//    绝不写 UserDefaults/文件/日志。状态目录持久化的是 Tailscale 自己的节点凭据，
//    不是 auth key（key 仅首次注册用一次）。
// ============================================================================

/// 把 TailscaleKit 的 Go 侧日志回灌到 SwiftUI 面板（真机取证用）。
struct SpikeLogSink: LogSink {
    let onLog: @Sendable (String) -> Void
    // 协议要求（Xcode 26 工具链下为必需见证）：不提供文件句柄，日志只经 log(_:) 回灌面板。
    let logFileHandle: Int32? = nil
    func log(_ message: String) {
        // TailscaleKit 从内部线程回调；统一切回主循环再改 @Published。
        DispatchQueue.main.async { onLog(message) }
    }
}

@MainActor
final class TailscaleSpikeManager: ObservableObject {
    enum Phase: Equatable {
        case idle
        case starting
        case up
        case failed(String)
    }

    /// 节点状态目录：App 沙盒 Documents/tailscale（Tailscale 在这持久化节点凭据）。
    static let stateDir: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("tailscale", isDirectory: true)
    }()

    /// 是否已有历史登录态（目录里有 Tailscale 写的状态文件）。仅做粗判，恢复仍以 up 成败为准。
    static var hasPersistedState: Bool {
        let dir = stateDir
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return false }
        return !entries.isEmpty
    }

    /// 2.3 dial 探针结论（真机取证：WiFi/蜂窝各跑一次）。
    enum DialResult: Equatable {
        case idle
        case running
        /// ok：HTTP 状态行、拨号+首包总耗时、收到字节数、响应头前若干字节预览
        case ok(statusLine: String, durationMS: Int, bytes: Int, preview: String)
        /// fail：人类可读原因（含 tailscale_errmsg / POSIX / HTTP 解析失败）
        case failed(String)
    }

    @Published var phase: Phase = .idle
    @Published var ip4: String = "—"
    @Published var ip6: String = "—"
    @Published var logs: [String] = []
    @Published var hasState: Bool = TailscaleSpikeManager.hasPersistedState
    @Published var dialResult: DialResult = .idle

    private var node: TailscaleNode?

    /// dsh-cloud 网关 tailnet 明文口（ACL 仅允许 tag:ipad 访问）。
    static let probeTarget = "100.99.84.35:8080"
    static let probePath = "/auth/login"

    /// nonisolated：LogSink 的 @Sendable 回调在 Go 内部线程触发，
    /// 这里统一派主队列后再碰 @Published，调用点无需处于 MainActor 隔离上下文。
    nonisolated private func appendLog(_ line: String) {
        let clipped = String(line.prefix(500))
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.logs.append(clipped)
            // 限制缓冲，避免 Go 日志无限增长撑爆面板。
            if self.logs.count > 300 { self.logs.removeFirst(self.logs.count - 300) }
        }
    }

    /// 首次入网（带 auth key）或杀进程后恢复（authKey 传 nil）。
    func bringUp(authKey: String?) async {
        guard phase != .starting else { return }
        phase = .starting
        appendLog(authKey == nil ? "▶ 用已存登录态 up（authKey=nil）…" : "▶ 用 auth key up（key 不落盘）…")

        // 状态目录确保存在。
        try? FileManager.default.createDirectory(at: Self.stateDir, withIntermediateDirectories: true)

        let config = Configuration(
            hostName: "dsh-ipad",          // tailnet 里显示的节点名；ACL 按 tag:ipad 授权
            path: Self.stateDir.path,
            authKey: authKey,
            controlURL: kDefaultControlURL,
            ephemeral: false               // 非临时节点：杀进程/下线后节点与登录态保留
        )

        do {
            let sink = SpikeLogSink { [weak self] line in self?.appendLog(line) }
            let node = try TailscaleNode(config: config, logger: sink)
            self.node = node
            try await node.up()

            // up 返回后地址可能尚未就绪：短轮询几次等 addrs。
            var addrs: IPAddresses = (nil, nil)
            for _ in 0..<10 {
                addrs = try await node.addrs()
                if addrs.ip4 != nil || addrs.ip6 != nil { break }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
            ip4 = addrs.ip4 ?? "—"
            ip6 = addrs.ip6 ?? "—"
            phase = .up
            hasState = Self.hasPersistedState
            appendLog("✅ up 成功：ip4=\(ip4) ip6=\(ip6)")
        } catch {
            phase = .failed("\(error)")
            appendLog("❌ up 失败：\(error)")
            // 失败（含 key 被吊销/无效）不污染状态，节点对象释放。
            node = nil
        }
    }

    func down() {
        guard let node else { return }
        // down() 是 actor 上的非 async throws 方法，跨 actor 隔离调用仍需 await。
        Task {
            try? await node.down()
            self.node = nil
            phase = .idle
            ip4 = "—"; ip6 = "—"
            appendLog("■ down（本地下线，状态目录保留）")
        }
    }

    // MARK: - Phase 2.3 进程内 tailnet dial 探针

    /// 必须先 up；拿 node.tailscale（C tailscale handle）在 detached task 里做阻塞式 HTTP GET。
    func runDialProbe() async {
        guard phase == .up, let node else {
            dialResult = .failed("节点未入网，先 up")
            return
        }
        dialResult = .running
        appendLog("▶ 2.3 探针：tailscale_dial tcp \(Self.probeTarget) GET \(Self.probePath) …")

        guard let handle = await node.tailscale else {
            dialResult = .failed("node.tailscale 为 nil（拿不到 C handle）")
            appendLog("❌ node.tailscale 为 nil")
            return
        }

        // C fd 的 dial/read/poll 全是阻塞调用，丢到 detached task 跑，避免卡主 actor。
        let outcome = await Task.detached(priority: .userInitiated) {
            Self.blockingHTTPGet(handle: handle, target: Self.probeTarget, path: Self.probePath)
        }.value

        switch outcome {
        case .success(let status, let ms, let bytes, let preview):
            dialResult = .ok(statusLine: status, durationMS: ms, bytes: bytes, preview: preview)
            appendLog("✅ 2.3 探针 \(status) · \(ms)ms · \(bytes) 字节")
        case .failure(let reason):
            dialResult = .failed(reason)
            appendLog("❌ 2.3 探针失败：\(reason)")
        }
    }

    private enum ProbeOutcome {
        case success(statusLine: String, durationMS: Int, bytes: Int, preview: String)
        case failure(String)
    }

    /// 纯阻塞 C 调用，必须在非 MainActor 上下文（detached task）执行。
    private nonisolated static func blockingHTTPGet(
        handle: TailscaleHandle, target: String, path: String
    ) -> ProbeOutcome {
        var conn: TailscaleConnection = -1
        let started = Date()

        // dial：失败时 tailscale_errmsg 取 Go 侧原因（ACL 拒绝/无路由/超时都在里面）。
        let dialRC = tailscale_dial(handle, "tcp", target, &conn)
        if dialRC != 0 || conn < 0 {
            var buf = [CChar](repeating: 0, count: 256)
            _ = tailscale_errmsg(handle, &buf, buf.count)
            return .failure("tailscale_dial rc=\(dialRC) err=\(String(cString: buf))")
        }
        defer { _ = Darwin.close(conn) }

        let request = "GET \(path) HTTP/1.1\r\nHost: \(target)\r\nConnection: close\r\nAccept: */*\r\nUser-Agent: dsh-ts-spike/2.3\r\n\r\n"
        guard let reqData = request.data(using: .utf8) else {
            return .failure("HTTP 请求编码失败")
        }
        let written = reqData.withUnsafeBytes { ptr -> Int in
            guard let base = ptr.bindMemory(to: UInt8.self).baseAddress else { return -1 }
            return Darwin.write(conn, base, reqData.count)
        }
        if written != reqData.count {
            return .failure("write 短写：\(written)/\(reqData.count)，errno=\(errno)")
        }

        // poll 等可读，累计 20s 上限（国际弱网 + DERP 回落给足余量）。
        var received = Data()
        let totalBudgetMS = 20_000
        while received.count < 65_536 {
            var pfds = pollfd(fd: conn, events: Int16(POLLIN), revents: 0)
            let elapsedMS = Int(Date().timeIntervalSince(started) * 1000)
            let remain = totalBudgetMS - elapsedMS
            if remain <= 0 {
                return parseHTTP(received, durationMS: elapsedMS, timeoutHint: true)
            }
            let pr = poll(&pfds, 1, Int32(min(remain, 5_000)))
            if pr < 0 {
                if errno == EINTR { continue }
                return .failure("poll 错误 errno=\(errno)")
            }
            if pr == 0 {
                // 本段 poll 无数据：弱网/DERP 回落可能更慢，继续循环直到 20s 总预算耗尽。
                continue
            }
            if (pfds.revents & Int16(POLLERR)) != 0
                || (pfds.revents & Int16(POLLHUP)) != 0
                || (pfds.revents & Int16(POLLIN)) != 0 {
                var chunk = [UInt8](repeating: 0, count: 8_192)
                let n = chunk.withUnsafeMutableBufferPointer { buf -> Int in
                    Darwin.read(conn, buf.baseAddress, buf.count)
                }
                if n < 0 {
                    if errno == EINTR { continue }
                    return .failure("read 错误 errno=\(errno)")
                }
                if n == 0 { break } // EOF：响应收完
                received.append(contentsOf: chunk.prefix(n))
            }
        }

        let ms = Int(Date().timeIntervalSince(started) * 1000)
        return parseHTTP(received, durationMS: ms, timeoutHint: false)
    }

    /// 解析裸 HTTP 响应：取状态行；至少要有 200。空数据按超时处理。
    private nonisolated static func parseHTTP(_ data: Data, durationMS: Int, timeoutHint: Bool) -> ProbeOutcome {
        guard !data.isEmpty else {
            return .failure(timeoutHint ? "20s 内无响应数据（P2P/DERP 不通或服务未监听）" : "连接关闭但无数据")
        }
        // 头部按 \r\n\r\n 截断；预览只取头区前 400 字节，避免 HTML body 刷屏。
        let headerEnd: Range<Data.Index>? = data.range(of: Data([0x0d, 0x0a, 0x0d, 0x0a]))
        let headerData = headerEnd.map { data.prefix(upTo: $0.lowerBound) } ?? data.prefix(400)
        let headerText = String(decoding: headerData, as: UTF8.self)
        guard !headerText.isEmpty else {
            return .failure("收到 \(data.count) 字节但不是可解析的 HTTP 文本")
        }
        let statusLine = headerText.components(separatedBy: "\r\n").first ?? "(无状态行)"
        let preview = String(headerText.prefix(400))
        if statusLine.contains(" 200") {
            return .success(statusLine: statusLine, durationMS: durationMS, bytes: data.count, preview: preview)
        }
        // 拿到了 HTTP 但非 200（302/401/502 等）：数据面是通的，这本身也是有效取证，标 success 但保留状态行。
        return .success(statusLine: statusLine + "（非 200）", durationMS: durationMS, bytes: data.count, preview: preview)
    }
}
