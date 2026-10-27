import Foundation
import OSLog
import TailscaleKit

// ============================================================================
// Phase 3.2 —— 产品级内嵌 tsnet 节点（App 级全局单例）。
//
// 产品铁律（2.2–2.6 真机结论）：节点生命周期**独立于任何页面**。
// 本类自持 static let shared，由 DSHRemoteApp.init 触碰保活；任何 SwiftUI 页面
// 只观察、不持有。spike 时代挂在调试 sheet @StateObject 上「关窗口即断联」已复现，
// 产品代码不得重犯。
//
// 状态机：idle → unauthenticated → starting → online(IP) / failed(reason)
//   - 冷启动：Documents/tailscale 有历史态 ⇒ 无 key 直接恢复 up（非 ephemeral 凭据在目录里）；
//             无历史态 ⇒ 停在 unauthenticated，等 3.3 设置页喂 key。
//   - online/failed 后可 signIn(新 key) 或 retry()；signOut 下节点并清凭据（3.3）。
//
// 阻塞纪律：TailscaleNode.up()/addrs() 是跨 actor 的 Go 阻塞调用，一律丢
// Task.detached(userInitiated)，不阻塞主队列（与 spike 实证一致）。
//
// 密钥纪律：authKey 仅作 bringUp 入参穿过，不写日志、不经 @Published 暴露。
// ============================================================================

/// 节点运行后端：抽协议是为 3.4 单测注入假后端（不引 Go 网络、不碰真机）。
/// 实现方负责把阻塞 up/addrs 丢后台；返回 up 后的地址（可能为 nil）。
/// authKey=nil 表示用状态目录里的已存登录态恢复。
protocol TailnetBackending: AnyObject {
    func bringUp(stateDir: URL, hostName: String, controlURL: String,
                 authKey: String?) async throws -> (ip4: String?, ip6: String?)
    func shutdown() async
}

/// 日志 sink：TailscaleKit 从 Go 内部线程回调，统一切主队列。产品侧不落文件，
/// 转发给 os_log（不进任何 UI 缓冲）。同样需要 logFileHandle 见证（Xcode 26 工具链）。
private struct TailnetLogSink: LogSink {
    let onLog: @Sendable (String) -> Void
    let logFileHandle: Int32? = nil
    func log(_ message: String) {
        let clipped = String(message.prefix(500))
        DispatchQueue.main.async { onLog(clipped) }
    }
}

/// TailscaleKit 生产后端：actor 串行化对 Go 节点对象的访问。
actor TailnetBackend: TailnetBackending {
    private var node: TailscaleKit.TailscaleNode?

    func bringUp(stateDir: URL, hostName: String, controlURL: String,
                 authKey: String?) async throws -> (ip4: String?, ip6: String?) {
        try? FileManager.default.createDirectory(at: stateDir, withIntermediateDirectories: true)
        let config = Configuration(
            hostName: hostName,
            path: stateDir.path,
            authKey: authKey,
            controlURL: controlURL,
            ephemeral: false
        )
        // 初始化本身不阻塞（spike 实证）；up/addrs 才是阻塞跨 actor 调用，丢 detached。
        let sink = TailnetLogSink { line in
            TailnetNode.logNode(line)
        }
        let node = try TailscaleKit.TailscaleNode(config: config, logger: sink)
        self.node = node
        try await Task.detached(priority: .userInitiated) {
            try await node.up()
        }.value

        // up 返回后地址可能尚未就绪：短轮询等 addrs（spike 真机 10×0.5s 足够）。
        var addrs: IPAddresses = (nil, nil)
        for _ in 0..<10 {
            addrs = try await Task.detached(priority: .userInitiated) {
                try await node.addrs()
            }.value
            if addrs.ip4 != nil || addrs.ip6 != nil { break }
            try? await Task.sleep(nanoseconds: 500_000_000)
        }
        return (addrs.ip4, addrs.ip6)
    }

    func shutdown() async {
        guard let node else { return }
        try? await node.down()
        self.node = nil
    }
}

@MainActor
final class TailnetNode: ObservableObject {
    /// App 级单例（见文件头产品铁律）。
    static let shared = TailnetNode()

    enum State: Equatable {
        /// 尚未决定能否恢复（autoStart 探测前的一瞬）。
        case idle
        /// 无历史态、Keychain 无 key：等用户在设置页喂 key。
        case unauthenticated
        /// up 中（首次带 key 或用历史态恢复）。
        case starting
        /// up 成功并拿到 tailnet 地址。
        case online(ip4: String, ip6: String)
        /// up 失败（坏 key / 吊销 / 网络 / DERP 不可达等），reason 人类可读、绝不含 key。
        case failed(String)
    }

    /// 节点状态目录：App 沙盒 Documents/tailscale（Tailscale 在这持久化节点凭据）。
    /// nonisolated：initializer 只碰 FileManager，且要能作 init 默认参数在 nonisolated 上下文求值。
    nonisolated static let stateDir: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("tailscale", isDirectory: true)
    }()

    /// 固定节点配置（plan 3.2）：官方 control、dsh-ipad、非 ephemeral。
    private let hostName = "dsh-ipad"
    private let controlURL = kDefaultControlURL

    @Published private(set) var state: State = .idle

    private let authStore: AuthKeyStoring
    private let makeBackend: () -> TailnetBackending
    private var backend: TailnetBackending?

    /// 本实例使用的状态目录（生产固定 Documents/tailscale；3.4 注入临时目录保证测试隔离）。
    private let stateDirectory: URL

    /// 3.4 测试入口：注入假 auth store / 临时状态目录 / 假后端；生产用默认 init。
    init(authStore: AuthKeyStoring = TailnetAuthStore(),
         stateDirectory: URL = TailnetNode.stateDir,
         backendFactory: @escaping () -> TailnetBackending = { TailnetBackend() }) {
        self.authStore = authStore
        self.stateDirectory = stateDirectory
        self.makeBackend = backendFactory
    }

    // MARK: - 冷启动自动恢复

    /// App 启动时调用一次：有历史态（或 Keychain 有残留 key）就尝试 up，否则停在未认证。
    func autoStart() {
        guard state == .idle else { return }
        if hasPersistedState || authStore.hasAuthKey() {
            // 有目录态：恢复优先（authKey 传 nil，凭据在状态目录里）。
            // 目录态缺失但 Keychain 有 key 的极端情况（目录被外部清过）：带 key 重入网。
            bringUp(authKey: hasPersistedState ? nil : authStore.loadAuthKey())
        } else {
            state = .unauthenticated
        }
    }

    // MARK: - 3.3 设置页入口

    /// 用户提交 auth key：存 Keychain 后带 key up。key 不入任何 @Published/日志。
    func signIn(authKey rawKey: String) async {
        let key = rawKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else {
            state = .failed("auth key 为空")
            return
        }
        guard !isStarting else { return }
        authStore.saveAuthKey(key)
        bringUp(authKey: key)
        await settle()
    }

    /// failed 后重试：优先历史态恢复，否则用 Keychain 里的 key。
    func retry() async {
        guard !isStarting else { return }
        bringUp(authKey: hasPersistedState ? nil : authStore.loadAuthKey())
        await settle()
    }

    /// 登出：下节点、删 Keychain item；状态目录默认保留（彻底清理由 wipeState 显式做）。
    func signOut() async {
        await backend?.shutdown()
        backend = nil
        authStore.deleteAuthKey()
        state = .unauthenticated
        TailnetNode.log("signOut：节点已下线，Keychain 凭据已删")
    }

    /// 3.3「彻底清除」：登出后连 Documents/tailscale 历史态一起删（删完回到未认证）。
    func wipeState() async {
        await signOut()
        if FileManager.default.fileExists(atPath: stateDirectory.path) {
            try? FileManager.default.removeItem(at: stateDirectory)
        }
        TailnetNode.log("wipeState：已删除节点状态目录")
    }

    // MARK: - up 内核

    private func bringUp(authKey: String?) {
        state = .starting
        TailnetNode.log(authKey == nil
                        ? "▶ 用已存登录态恢复节点…"
                        : "▶ 用 auth key 入网（key 不记录）…")

        let backend = makeBackend()
        self.backend = backend
        let dir = stateDirectory
        let host = hostName
        let ctl = controlURL

        Task { @MainActor in
            do {
                let addrs = try await backend.bringUp(
                    stateDir: dir, hostName: host, controlURL: ctl, authKey: authKey)
                let ip4 = addrs.ip4 ?? ""
                let ip6 = addrs.ip6 ?? ""
                if ip4.isEmpty && ip6.isEmpty {
                    // up 未抛但 5s 内地址没就绪：判失败、释放后端。
                    self.backend = nil
                    state = .failed("节点已启动但未取得 tailnet 地址（检查网络/DERP）")
                    TailnetNode.log("❌ up 后无地址")
                    return
                }
                state = .online(ip4: ip4.isEmpty ? "—" : ip4,
                                ip6: ip6.isEmpty ? "—" : ip6)
                TailnetNode.log("✅ 节点在线：ip4=\(ip4.isEmpty ? "—" : ip4) ip6=\(ip6.isEmpty ? "—" : ip6)")
            } catch {
                // 坏 key/吊销/网络原因都在 error 文本里；error 由 TailscaleKit 产生，不含入参 key。
                self.backend = nil
                state = .failed("\(error)")
                TailnetNode.log("❌ 入网失败：\(error)")
            }
        }
    }

    /// 带关联值的 .online 不能直接用 `== .starting` 比较；统一走模式匹配。
    private var isStarting: Bool {
        if case .starting = state { return true }
        return false
    }

    /// 等到离开 starting（signIn/retry 的 UI 用）；最多 10s 避免死等。
    private func settle() async {
        for _ in 0..<200 {
            if !isStarting { return }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    private var hasPersistedState: Bool {
        guard let entries = try? FileManager.default
            .contentsOfDirectory(atPath: stateDirectory.path) else { return false }
        return !entries.isEmpty
    }

    // MARK: - 日志（os_log；节点 Go 日志与状态迁移，绝不含 key）

    // nonisolated：LogSink 回调在 Go 线程经主队列异步调用这些静态入口，
    // 不能要求 MainActor 隔离；Logger 自身 Sendable，日志内容也绝不含 key。
    private nonisolated static let logger = Logger(subsystem: "dsh.tailnet", category: "node")

    fileprivate nonisolated static func log(_ message: String) {
        logger.log("\(message, privacy: .public)")
    }

    /// TailscaleKit Go 侧日志回灌；只进 os_log。
    fileprivate nonisolated static func logNode(_ line: String) {
        logger.log("\(line, privacy: .public)")
    }
}
