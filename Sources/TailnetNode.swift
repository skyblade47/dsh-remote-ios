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
//   - starting 可被取消（cancelBringUp）或被弱网看门狗超时打断（3.5 真机：弱网到
//     控制面不通时 up() 无限阻塞，曾导致 starting 锁死全部按钮）；每次入网带代际
//     令牌 generation，被作废的旧回调一律丢弃，不得覆盖新状态。
//
// 阻塞纪律：TailscaleNode.up()/addrs() 是跨 actor 的 Go 阻塞调用，一律丢
// Task.detached(userInitiated)，不阻塞主队列（与 spike 实证一致）。up() 本身无
// 超时，由本类的看门狗在 bringUpTimeout 后 down() 打断，弱网不死等。
//
// 密钥纪律：authKey 仅作 bringUp 入参穿过，不写日志、不经 @Published 暴露。
// ============================================================================

/// 节点运行后端：抽协议是为 3.4 单测注入假后端（不引 Go 网络、不碰真机）。
/// 实现方负责把阻塞 up/addrs 丢后台；返回 up 后的地址（可能为 nil）。
/// authKey=nil 表示用状态目录里的已存登录态恢复。
///
/// dialHandle：online 后取 C tailscale handle 供 4.1 本地桥每连接 tailscale_dial；
/// 节点未起/已下时返回 nil（调用方不得起桥）。返回裸 Int32 而非 TailscaleHandle，
/// 使测试替身无需 import TailscaleKit。
protocol TailnetBackending: AnyObject {
    func bringUp(stateDir: URL, hostName: String, controlURL: String,
                 authKey: String?) async throws -> (ip4: String?, ip6: String?)
    func shutdown() async
    func dialHandle() async -> Int32?
}

/// 日志 sink：TailscaleKit 从 Go 内部线程回调，统一切主队列后交给构造时注入的
/// onLog（生产即「创建本 backend 的那个节点实例」的实例日志入口）。不落文件。
/// 同样需要 logFileHandle 见证（Xcode 26 工具链）。
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

    /// Go 侧日志回灌：由创建 backend 的 TailnetNode 实例注入，绑到该实例的
    /// 内存缓冲（不再写死单例，注入实例的测试/多实例也能收到自己的日志）。
    private let onLog: @Sendable (String) -> Void

    init(onLog: @escaping @Sendable (String) -> Void = { _ in }) {
        self.onLog = onLog
    }

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
        // sink 已 hop 到主队列，onLog 直连节点实例的 MainActor 日志入口。
        let sink = TailnetLogSink { [onLog] line in onLog(line) }
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

    /// 4.1：online 后取 C tailscale handle 给本地桥做 tailscale_dial；下节点后为 nil。
    /// 阻塞 C 调用（dial/read/write）发生在连接层的 Task.detached，不经本 actor。
    func dialHandle() async -> Int32? {
        await node?.tailscale
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

    /// 方案 D / 4.1：localhost 反代生命周期（与节点同生共死）。
    /// online 自动起桥；signOut/cancel/failed 自动停桥。前后台重建留 Phase 6。
    enum BridgeState: Equatable {
        case stopped
        case starting
        case running(String) // http://127.0.0.1:<port>
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

    /// 4.1 localhost 反代状态（设置页展示；WKWebView Phase 5 起固定读 UserDefaults base）。
    @Published private(set) var bridge: BridgeState = .stopped

    /// 运行中的 loopback 监听（停桥时 cancel 并关闭全部活动连接）。
    private var loopback: LoopbackProxy?

    /// 最近节点日志（内存环形，最多 recentLogLimit 条；只含状态迁移/Go 日志，绝不含 key）。
    /// 真机无 Mac 看不到 os_log，设置页靠它排查弱网卡死。
    @Published private(set) var recentLogs: [String] = []

    private let authStore: AuthKeyStoring
    /// 3.4 单测注入的假后端工厂；nil 时运行期建生产 TailnetBackend（见 makeBackendInstance）。
    /// 不直接在 init 里建默认工厂：逃逸闭包在 init 内捕获 self 会触发 DI「used before
    /// being initialized」，故把「创建 backend 并绑实例日志」延迟到 self 完整后的实例方法。
    private let injectedBackendFactory: (() -> TailnetBackending)?
    private var backend: TailnetBackending?

    /// 本实例使用的状态目录（生产固定 Documents/tailscale；3.4 注入临时目录保证测试隔离）。
    private let stateDirectory: URL

    /// 入网看门狗超时：弱网到控制面不通时，up() 多久还没回来就 down() 打断并上屏失败。
    private let bringUpTimeout: TimeInterval
    private let recentLogLimit = 50

    /// 代际令牌：每次 bringUp/cancel/signOut 自增；旧 bringUp Task 的迟到回调只认自己
    /// 那一版，作废后不得写 state（取消后旧结果迟到覆盖新入网是典型竞态）。
    private var generation = 0
    /// 已被看门狗判定超时的代际：旧回调 catch 到时据此给「超时」而非泛化错误文案。
    private var timedOutGenerations = Set<Int>()

    /// 3.4 测试入口：注入假 auth store / 临时状态目录 / 假后端 / 短超时；生产用默认 init。
    init(authStore: AuthKeyStoring = TailnetAuthStore(),
         stateDirectory: URL = TailnetNode.stateDir,
         bringUpTimeout: TimeInterval = 45,
         backendFactory: (() -> TailnetBackending)? = nil) {
        self.authStore = authStore
        self.stateDirectory = stateDirectory
        self.bringUpTimeout = bringUpTimeout
        self.injectedBackendFactory = backendFactory
    }

    /// 运行期建本次入网的 backend：测试用注入工厂；生产建 TailnetBackend 并把 Go 日志
    /// 回灌到本节点实例的日志入口（[weak self] 避免 backend→闭包→node 环）。
    private func makeBackendInstance() -> TailnetBackending {
        if let injectedBackendFactory { return injectedBackendFactory() }
        return TailnetBackend { [weak self] line in
            Task { @MainActor in self?.log(line) }
        }
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
        generation &+= 1
        timedOutGenerations.removeAll()
        await stopBridge()
        await backend?.shutdown()
        backend = nil
        authStore.deleteAuthKey()
        state = .unauthenticated
        log("signOut：节点已下线，Keychain 凭据已删")
    }

    /// 3.3「彻底清除」：登出后连 Documents/tailscale 历史态一起删（删完回到未认证）。
    func wipeState() async {
        await signOut()
        if FileManager.default.fileExists(atPath: stateDirectory.path) {
            try? FileManager.default.removeItem(at: stateDirectory)
        }
        log("wipeState：已删除节点状态目录")
    }

    // MARK: - up 内核

    private func bringUp(authKey: String?) {
        generation &+= 1
        let gen = generation
        timedOutGenerations.remove(gen)
        state = .starting
        log(authKey == nil
            ? "▶ 用已存登录态恢复节点…"
            : "▶ 用 auth key 入网（key 不记录）…")

        let backend = makeBackendInstance()
        self.backend = backend
        let dir = stateDirectory
        let host = hostName
        let ctl = controlURL
        let timeout = bringUpTimeout

        // 弱网看门狗（3.5 真机缺陷）：up() 无超时，控制面不通时会无限挂起。到点仍未
        // 回来就 down() 打断（actor 可重入：up 跑在 detached 里，shutdown 能进去），
        // 旧 bringUp 因此抛错，被下面 catch 按「超时」上屏。只认自己这一版 generation。
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            guard gen == self.generation, case .starting = self.state else { return }
            self.timedOutGenerations.insert(gen)
            self.log("⏱ 入网 \(Int(timeout))s 未完成，判定超时，中断 up…")
            await backend.shutdown()
        }

        Task { @MainActor in
            do {
                let addrs = try await backend.bringUp(
                    stateDir: dir, hostName: host, controlURL: ctl, authKey: authKey)
                // 期间已被取消/登出/新一次入网取代：迟到结果一律丢弃。
                guard gen == self.generation else { return }
                timedOutGenerations.remove(gen)
                let ip4 = addrs.ip4 ?? ""
                let ip6 = addrs.ip6 ?? ""
                if ip4.isEmpty && ip6.isEmpty {
                    // up 未抛但轮询窗口内地址没就绪：判失败、释放后端。
                    await self.stopBridge()
                    self.backend = nil
                    state = .failed("节点已启动但未取得 tailnet 地址（检查网络/DERP）")
                    self.log("❌ up 后无地址")
                    return
                }
                state = .online(ip4: ip4.isEmpty ? "—" : ip4,
                                ip6: ip6.isEmpty ? "—" : ip6)
                self.log("✅ 节点在线：ip4=\(ip4.isEmpty ? "—" : ip4) ip6=\(ip6.isEmpty ? "—" : ip6)")
                await self.startBridge(gen: gen)
            } catch {
                guard gen == self.generation else { return }
                let wasTimedOut = timedOutGenerations.contains(gen)
                timedOutGenerations.remove(gen)
                await self.stopBridge()
                self.backend = nil
                // 坏 key/吊销/网络原因都在 error 文本里；error 由 TailscaleKit 产生，不含入参 key。
                if wasTimedOut {
                    state = .failed("入网超时（\(Int(timeout))s）：国际网络/DERP 不可达，检查网络后重试")
                    self.log("❌ 入网超时（弱网/控制面不可达）")
                } else {
                    state = .failed("\(error)")
                    self.log("❌ 入网失败：\(error)")
                }
            }
        }
    }

    /// starting 中用户主动取消：作废旧代际、down() 打断阻塞中的 up，回未认证态
    /// （Keychain key 保留；覆盖安装残留的旧状态目录可用「彻底清除」删掉）。
    func cancelBringUp() async {
        guard isStarting else { return }
        generation &+= 1
        timedOutGenerations.removeAll()
        await stopBridge()
        await backend?.shutdown()
        backend = nil
        state = .unauthenticated
        log("已取消入网")
    }

    /// 带关联值的 .online 不能直接用 `== .starting` 比较；统一走模式匹配。
    private var isStarting: Bool {
        if case .starting = state { return true }
        return false
    }

    // MARK: - 4.1 localhost 反代（与节点同生共死）

    /// online 后起本地桥：Bundle.main 壳资产路由 + HttpBridge + TailnetDialConnecter
    /// → LoopbackProxy(127.0.0.1 动态端口)。base 落 UserDefaults DSHLoopbackBaseURL，
    /// 供 Phase 5 的 WKWebView 固定加载。spike 2.4 真机已证此装配端到端可用。
    /// 只认自己这一版 generation：期间被取消/登出/新入网取代则丢弃迟到结果。
    private func startBridge(gen: Int) async {
        // starting/running 不重复起；stopped/failed 都允许起（failed 即重试入口）。
        if case .starting = bridge { return }
        if case .running = bridge { return }
        bridge = .starting
        log("▶ 起本地桥：127.0.0.1 → tailscale_dial → 100.99.84.35:8080 …")

        guard let handle = await backend?.dialHandle() else {
            guard gen == self.generation else { return }
            bridge = .failed("拿不到 tailscale handle（节点未在线）")
            log("❌ 起桥失败：tailscale handle 为 nil")
            return
        }

        let routes = ShellAssetRoutes { name in
            guard let url = Bundle.main.url(forResource: name, withExtension: nil) else { return nil }
            return try? Data(contentsOf: url)
        }
        let httpBridge = HttpBridge(routes: routes,
                                    connecter: TailnetDialConnecter(handle: TailscaleHandle(handle)))
        let proxy = LoopbackProxy(bridge: httpBridge)
        loopback = proxy
        do {
            let base = try await proxy.start()
            guard gen == self.generation else {
                // 起桥期间已被登出/取消：把刚起好的监听立刻撤掉，不泄漏端口。
                proxy.stop()
                if self.loopback === proxy { self.loopback = nil }
                return
            }
            bridge = .running(base.absoluteString)
            log("✅ 本地桥就绪：\(base.absoluteString)")
        } catch {
            guard gen == self.generation else { return }
            bridge = .failed("\(error)")
            loopback = nil
            log("❌ 起桥失败：\(error)")
        }
    }

    /// 停本地桥（signOut/cancel/失败/重入网前）；幂等。
    private func stopBridge() async {
        loopback?.stop()
        loopback = nil
        if case .stopped = bridge { return }
        bridge = .stopped
        log("■ 本地桥已停")
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

    // MARK: - 日志（os_log + 内存环形；节点 Go 日志与状态迁移，绝不含 key）

    // nonisolated：Logger 是 Sendable 值类型、let 初始化无 MainActor 状态；
    // 供实例 log(_:) 与默认 backend 工厂注入的 Go 日志回调共用。
    private nonisolated static let logger = Logger(subsystem: "dsh.tailnet", category: "node")

    /// 唯一日志入口（MainActor）：状态迁移日志与 backend 回灌的 Go 日志都走这里，
    /// 同进 os_log 与**本实例**的 @Published 环形缓冲（真机设置页可见，不落盘、绝不含 key）。
    private func log(_ message: String) {
        let clipped = String(message.prefix(500))
        Self.logger.log("\(clipped, privacy: .public)")
        let stamp = Date.now.formatted(date: .omitted, time: .shortened)
        recentLogs.append("[\(stamp)] \(clipped)")
        if recentLogs.count > recentLogLimit {
            recentLogs.removeFirst(recentLogs.count - recentLogLimit)
        }
    }
}
