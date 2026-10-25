import Foundation
import SwiftUI
import TailscaleKit

// ============================================================================
// Phase 2.2 spike —— Tailscale 非交互入网（**非产品代码，闸门 B 结论固化后删除**）
//
// 只回答 2.2：
//   ① auth key 非交互 up（不弹 Tailscale 官方登录浏览器）；
//   ② up 成功后能取到 tailnet IP（addrs）；
//   ③ 杀进程重启，登录态靠 Documents/tailscale 状态目录恢复（authKey 传 nil）。
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

    @Published var phase: Phase = .idle
    @Published var ip4: String = "—"
    @Published var ip6: String = "—"
    @Published var logs: [String] = []
    @Published var hasState: Bool = TailscaleSpikeManager.hasPersistedState

    private var node: TailscaleNode?

    private func appendLog(_ line: String) {
        // 限制缓冲，避免 Go 日志无限增长撑爆面板。
        logs.append(String(line.prefix(500)))
        if logs.count > 300 { logs.removeFirst(logs.count - 300) }
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
}
