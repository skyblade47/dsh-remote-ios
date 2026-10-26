import Foundation
import SwiftUI
import Network
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

    /// 2.4 本地桥状态（up 后手动起桥；down 时自动停）。
    enum BridgeState: Equatable {
        case stopped
        case starting
        case running(URL)
        case failed(String)
    }

    // MARK: 2.5 弱网线路观测

    /// 到网关的实际线路类型（ipnstate.Status：CurAddr 非空=P2P，空=走 Relay DERP）。
    enum PathKind: String, Equatable {
        case p2p       // CurAddr 非空：UDP 41641 直连
        case derp      // CurAddr 空、Relay 非空：DERP 中继（期望 sha / region 900）
        case idle      // 找到网关但无握手（从未通信/挂起后）
        case offline   // 网关 peer Online=false
        case missing   // Peer map 里找不到网关 IP（节点被删除/ACL 变更/失败态）
        case errored   // status_json 本身失败（节点未 up 等）
    }

    /// 一次线路快照（带时间戳，连续刷新即可人工量 P2P↔DERP 切换耗时）。
    struct NetPathSnapshot: Equatable, Identifiable {
        let id = UUID()
        let date: Date
        let backendState: String
        let selfOnline: Bool
        let gatewayOnline: Bool
        let kind: PathKind
        let curAddr: String
        let relay: String
        let handshakeAgeSeconds: Int   // -1 = 无握手时间
        let rxBytes: Int64
        let txBytes: Int64
        let onlinePeers: Int
        let note: String              // 错误描述（kind == .errored 时）
    }

    // MARK: 2.6 后台挂起往返复查

    /// 回前台一次复查的四项结论（①C 内存 LocalAPI ②自建桥端口 ③tailscale_dial ④Swift loopback LocalAPI 对比）。
    struct ResumeReport: Equatable, Identifiable {
        let id = UUID()
        let date: Date
        let suspendedSeconds: Int
        let memStatus: String
        let bridgeProbe: String
        let dialProbe: String
        let swiftStatus: String
    }

    @Published var phase: Phase = .idle
    @Published var ip4: String = "—"
    @Published var ip6: String = "—"
    @Published var logs: [String] = []
    @Published var hasState: Bool = TailscaleSpikeManager.hasPersistedState
    @Published var dialResult: DialResult = .idle
    @Published var bridge: BridgeState = .stopped
    @Published var pathSnapshots: [NetPathSnapshot] = []
    @Published var pathWatching: Bool = false
    @Published var resumeReports: [ResumeReport] = []

    private var node: TailscaleNode?
    private var loopback: LoopbackProxy?
    private var pathWatchTask: Task<Void, Never>?

    /// dsh-cloud 网关 tailnet 明文口（ACL 仅允许 tag:ipad 访问）。
    static let probeTarget = "100.99.84.35:8080"
    static let probePath = "/auth/login"
    /// 2.5 线路判定锚点：网关 tailnet IPv4（从 Peer map 按 TailscaleIPs 匹配）。
    static let gatewayTailnetIP = "100.99.84.35"

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
        stopBridge()
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

    // MARK: - Phase 2.4 localhost 本地桥（WKWebView → 127.0.0.1 → tailscale_dial）

    /// up 成功后起桥：HttpBridge 复用 4.1–4.5 全部设备无关逻辑，唯一真机件是
    /// TailscaleDialConnecter（每连接 tailscale_dial 到 100.99.84.35:8080）。
    func startBridge() async {
        guard phase == .up, let node else {
            bridge = .failed("节点未入网，先 up")
            return
        }
        // starting/running 不重复起；stopped/failed 都允许起（failed 即重试入口）。
        if case .starting = bridge { return }
        if case .running = bridge { return }
        bridge = .starting
        appendLog("▶ 2.4 起本地桥：127.0.0.1 → tailscale_dial → \(Self.probeTarget) …")

        guard let handle = await node.tailscale else {
            bridge = .failed("node.tailscale 为 nil（拿不到 C handle）")
            appendLog("❌ 2.4 起桥失败：node.tailscale 为 nil")
            return
        }

        let routes = ShellAssetRoutes { name in
            guard let url = Bundle.main.url(forResource: name, withExtension: nil) else { return nil }
            return try? Data(contentsOf: url)
        }
        let httpBridge = HttpBridge(routes: routes, connecter: TailscaleDialConnecter(handle: handle))
        let proxy = LoopbackProxy(bridge: httpBridge)
        loopback = proxy
        do {
            let base = try await proxy.start()
            bridge = .running(base)
            appendLog("✅ 2.4 本地桥就绪：\(base.absoluteString)（已写 UserDefaults DSHLoopbackBaseURL）")
        } catch {
            bridge = .failed("\(error)")
            loopback = nil
            appendLog("❌ 2.4 起桥失败：\(error)")
        }
    }

    func stopBridge() {
        loopback?.stop()
        loopback = nil
        pathWatchTask?.cancel()
        pathWatchTask = nil
        pathWatching = false
        if case .stopped = bridge { return }
        bridge = .stopped
        appendLog("■ 2.4 本地桥已停")
    }

    // MARK: - Phase 2.5 弱网线路观测（tailscale_status_json / 内存 LocalAPI）

    /// 刷新一次线路快照。走 C API tailscale_status_json → tsnet 内存 LocalAPI listener，
    /// 不经 loopback HTTP（iOS 挂起期 OS 回收 loopback TCP listener 后仍可用，2.6 复用同一通道）。
    func refreshPath() async {
        guard let node else {
            appendPath(NetPathSnapshot(date: Date(), backendState: "—", selfOnline: false, gatewayOnline: false,
                                       kind: .errored, curAddr: "", relay: "", handshakeAgeSeconds: -1,
                                       rxBytes: 0, txBytes: 0, onlinePeers: 0, note: "节点未入网"))
            return
        }
        guard let handle = await node.tailscale else {
            appendPath(NetPathSnapshot(date: Date(), backendState: "—", selfOnline: false, gatewayOnline: false,
                                       kind: .errored, curAddr: "", relay: "", handshakeAgeSeconds: -1,
                                       rxBytes: 0, txBytes: 0, onlinePeers: 0, note: "node.tailscale 为 nil"))
            return
        }
        let raw = await Task.detached(priority: .userInitiated) {
            Self.blockingStatusJSON(handle: handle)
        }.value
        appendPath(Self.parseStatus(raw: raw, date: Date()))
    }

    private func appendPath(_ snap: NetPathSnapshot) {
        pathSnapshots.append(snap)
        if pathSnapshots.count > 30 { pathSnapshots.removeFirst(pathSnapshots.count - 30) }
        let kindText: String
        switch snap.kind {
        case .p2p:    kindText = "P2P 直连 \(snap.curAddr)"
        case .derp:   kindText = "DERP 中继 relay=\(snap.relay)"
        case .idle:   kindText = "无活跃线路（无握手）"
        case .offline:kindText = "网关离线"
        case .missing:kindText = "Peer map 无网关（失败态）"
        case .errored:kindText = "status_json 失败：\(snap.note)"
        }
        appendLog("🛰 2.5 线路：\(kindText) · 握手 \(snap.handshakeAgeSeconds < 0 ? "—" : "\(snap.handshakeAgeSeconds)s 前") · ↓\(snap.rxBytes) ↑\(snap.txBytes)")
    }

    /// 连续刷新（每 2s 一次，最多 15 次≈30s），封 UDP 41641 时用记录序列人工量切换耗时。
    func togglePathWatch() async {
        if pathWatching {
            pathWatchTask?.cancel()
            pathWatchTask = nil
            pathWatching = false
            appendLog("■ 2.5 连续线路记录已停")
            return
        }
        pathWatching = true
        appendLog("▶ 2.5 开始连续线路记录（2s × 15 次）")
        pathWatchTask = Task { [weak self] in
            for _ in 0..<15 {
                guard !Task.isCancelled else { break }
                await self?.refreshPath()
                do { try await Task.sleep(nanoseconds: 2_000_000_000) }
                catch { break }
            }
            await MainActor.run { [weak self] in
                guard let self else { return }
                self.pathWatching = false
                self.pathWatchTask = nil
            }
        }
    }

    private enum StatusFetch {
        case ok(String)
        case failed(String)
    }

    /// 阻塞 C 调用：tailscale_status_json 写出 malloc 的 NUL 结尾 JSON，调用方 free。
    private nonisolated static func blockingStatusJSON(handle: TailscaleHandle) -> StatusFetch {
        var ptr: UnsafeMutablePointer<CChar>?
        let rc = tailscale_status_json(handle, &ptr)
        guard rc == 0, let ptr else {
            var buf = [CChar](repeating: 0, count: 256)
            _ = tailscale_errmsg(handle, &buf, buf.count)
            return .failed("tailscale_status_json rc=\(rc) err=\(String(cString: buf))")
        }
        defer { free(ptr) }
        return .ok(String(cString: ptr))
    }

    /// 动态解析 ipnstate.Status（不建完整 Decodable 模型，只取取证字段）。
    private nonisolated static func parseStatus(raw: StatusFetch, date: Date) -> NetPathSnapshot {
        guard case .ok(let jsonText) = raw,
              let data = jsonText.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            if case .failed(let reason) = raw {
                return NetPathSnapshot(date: date, backendState: "—", selfOnline: false, gatewayOnline: false,
                                       kind: .errored, curAddr: "", relay: "", handshakeAgeSeconds: -1,
                                       rxBytes: 0, txBytes: 0, onlinePeers: 0, note: reason)
            }
            return NetPathSnapshot(date: date, backendState: "—", selfOnline: false, gatewayOnline: false,
                                   kind: .errored, curAddr: "", relay: "", handshakeAgeSeconds: -1,
                                   rxBytes: 0, txBytes: 0, onlinePeers: 0, note: "JSON 解析失败")
        }

        let backend = (root["BackendState"] as? String) ?? "—"
        let selfStatus = root["Self"] as? [String: Any]
        let selfOnline = (selfStatus?["Online"] as? Bool) ?? false
        let peers = (root["Peer"] as? [String: [String: Any]]) ?? [:]
        let onlinePeers = peers.values.filter { ($0["Online"] as? Bool) == true }.count

        // 网关 peer：TailscaleIPs 含 100.99.84.35；找不到时回退枚举里在线且有地址的 peer。
        var gw = peers.first(where: {
            (($0.value["TailscaleIPs"] as? [String]) ?? []).contains(gatewayTailnetIP)
        })?.value
        if gw == nil {
            gw = peers.first(where: {
                ($0.value["Online"] as? Bool) == true
                && (($0.value["TailscaleIPs"] as? [String]) ?? []).contains(where: { $0.hasPrefix("100.") })
            })?.value
        }
        guard let gw else {
            return NetPathSnapshot(date: date, backendState: backend, selfOnline: selfOnline,
                                   gatewayOnline: false, kind: .missing, curAddr: "", relay: "",
                                   handshakeAgeSeconds: -1, rxBytes: 0, txBytes: 0,
                                   onlinePeers: onlinePeers, note: "")
        }
        let online = (gw["Online"] as? Bool) ?? false
        let curAddr = (gw["CurAddr"] as? String) ?? ""
        let relay = (gw["Relay"] as? String) ?? ""
        let rx = (gw["RxBytes"] as? Int64) ?? Int64((gw["RxBytes"] as? Int) ?? 0)
        let tx = (gw["TxBytes"] as? Int64) ?? Int64((gw["TxBytes"] as? Int) ?? 0)
        var age = -1
        // Go time.Time 零值序列化为 "0001-01-01T00:00:00Z"（timeInterval 为大负数而非 0），按 >0 判定。
        if let hs = gw["LastHandshake"] as? String,
           let hsDate = parseTS(hs), hsDate.timeIntervalSince1970 > 0 {
            age = max(0, Int(date.timeIntervalSince(hsDate)))
        }
        let kind: PathKind
        if !online { kind = .offline }
        else if !curAddr.isEmpty { kind = .p2p }
        else if !relay.isEmpty { kind = age >= 0 ? .derp : .idle }
        else { kind = .idle }

        return NetPathSnapshot(date: date, backendState: backend, selfOnline: selfOnline,
                               gatewayOnline: online, kind: kind, curAddr: curAddr, relay: relay,
                               handshakeAgeSeconds: age, rxBytes: rx, txBytes: tx,
                               onlinePeers: onlinePeers, note: "")
    }

    /// Go time.Time JSON = RFC3339Nano：纳秒小数位可变（最多 9 位），全 0 时省略小数。
    /// 用 ISO8601DateFormatter 两种形态依次尝试，避免手工截断小数位错位。
    private nonisolated static func parseTS(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    // MARK: - Phase 2.6 后台挂起 → 回前台复查/重建

    /// 回前台复查：①C 内存 LocalAPI status ②自建 127.0.0.1 桥端口 TCP 探活（失败则重建）
    /// ③tailscale_dial 重跑 GET ④Swift node.statusJSON()（走 loopback HTTP，挂起后预期可能失败，对照组）。
    func handleResume(suspendedSeconds: Int) async {
        appendLog("▶ 2.6 回前台复查（挂起 \(suspendedSeconds)s）…")
        guard let node else {
            appendLog("❌ 2.6 节点对象已不存在，跳过复查")
            return
        }
        let handle = await node.tailscale

        // ① 内存 LocalAPI（detached 阻塞 C）
        let memStart = Date()
        var memText = "—"
        if let handle {
            let raw = await Task.detached(priority: .userInitiated) {
                Self.blockingStatusJSON(handle: handle)
            }.value
            let snap = Self.parseStatus(raw: raw, date: Date())
            memText = "\(Int(Date().timeIntervalSince(memStart) * 1000))ms · backend=\(snap.backendState) · self=\(snap.selfOnline ? "online" : "offline") · \(snap.kind.rawValue)"
        } else {
            memText = "node.tailscale 为 nil"
        }

        // ② 自建桥端口探活；仅在桥曾 running 时探，挂了 stop+start 重建并记耗时。
        var bridgeText = "桥未启动"
        if case .running(let base) = bridge, let port = base.port {
            let probeMS = await Self.loopbackPortAlive(port: port)
            if probeMS >= 0 {
                bridgeText = "端口存活（TCP connect \(probeMS)ms）"
            } else {
                bridgeText = "端口失效，重建中…"
                appendLog("⚠ 2.6 127.0.0.1:\(port) 探活失败，重建本地桥")
                let t0 = Date()
                stopBridge()
                try? await Task.sleep(nanoseconds: 300_000_000)
                await startBridge()
                let rebuildMS = Int(Date().timeIntervalSince(t0) * 1000)
                if case .running = bridge { bridgeText = "端口失效→已重建（\(rebuildMS)ms）" }
                else { bridgeText = "端口失效→重建失败（\(rebuildMS)ms）" }
            }
        }

        // ③ tailscale_dial 重跑 GET（回前台给 12s 预算）
        var dialText = "—"
        if let handle {
            let outcome = await Task.detached(priority: .userInitiated) {
                Self.blockingHTTPGet(handle: handle, target: Self.probeTarget, path: Self.probePath, budgetMS: 12_000)
            }.value
            switch outcome {
            case .success(let status, let ms, let bytes, _):
                dialText = "\(status) · \(ms)ms · \(bytes)B"
            case .failure(let reason):
                dialText = "失败：\(reason)"
            }
        } else {
            dialText = "无 handle"
        }

        // ④ Swift node.statusJSON()（走 tsnet loopback HTTP server）：与①对照，验证 header 所述挂起回收行为。
        //    加 8s 超时竞赛：loopback listener 被回收后 connect 可能挂起，不能让整次复查永久等待。
        let swiftStart = Date()
        let swiftText: String
        do {
            let ms = try await withThrowingTaskGroup(of: Int.self) { group -> Int in
                group.addTask {
                    _ = try await node.statusJSON()
                    return Int(Date().timeIntervalSince(swiftStart) * 1000)
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: 8_000_000_000)
                    throw CancellationError()
                }
                // 先拿到首个结果：成功或 statusJSON 的失败都终结竞赛；
                // 随后取消并以 nextResult 排空（吞 sleep 子任务的 CancellationError，
                // 否则成功路径会被它在 group 退出时重新抛出、误报超时）。
                let first = try await group.nextResult()
                group.cancelAll()
                while await group.nextResult() != nil {}
                return try first?.get() ?? -1
            }
            swiftText = "OK \(ms)ms（loopback HTTP 仍活）"
        } catch is CancellationError {
            swiftText = "8s 超时（loopback HTTP 疑似被回收，对照证据）"
        } catch {
            swiftText = "失败 \(Int(Date().timeIntervalSince(swiftStart) * 1000))ms：\(String(describing: error).prefix(120))"
        }

        let report = ResumeReport(date: Date(), suspendedSeconds: suspendedSeconds,
                                  memStatus: memText, bridgeProbe: bridgeText,
                                  dialProbe: dialText, swiftStatus: swiftText)
        resumeReports.append(report)
        if resumeReports.count > 10 { resumeReports.removeFirst(resumeReports.count - 10) }
        appendLog("✅ 2.6 复查完成：①\(memText) ②\(bridgeText) ③\(dialText) ④\(swiftText)")
    }

    /// TCP 连一次 127.0.0.1:port，返回 connect 毫秒；失败/4s 超时返回 -1。
    private nonisolated static func loopbackPortAlive(port: Int) async -> Int {
        let started = Date()
        do {
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    // conn 在 box 里：onCancel 可能先于 continuation body 执行，两者都要能 cancel。
                    let box = NWConnectionBox()
                    try await withTaskCancellationHandler {
                        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                            let conn = NWConnection(
                                host: NWEndpoint.Host("127.0.0.1"),
                                port: NWEndpoint.Port(rawValue: UInt16(port))!,
                                using: .tcp)
                            box.conn = conn
                            // ready/failed/取消三路只 resume 一次。
                            let lock = NSLock()
                            var didResume = false
                            func finish(_ result: Result<Void, Error>) {
                                lock.lock()
                                guard !didResume else { lock.unlock(); return }
                                didResume = true
                                lock.unlock()
                                conn.cancel()
                                cont.resume(with: result)
                            }
                            conn.stateUpdateHandler = { state in
                                switch state {
                                case .ready: finish(.success(()))
                                case .failed(let error): finish(.failure(error))
                                // 超时路径 cancelAll → onCancel → conn.cancel() 会进这里：
                                // 必须 resume，否则 task group 等待该子任务结束时永久挂起。
                                case .cancelled: finish(.failure(CancellationError()))
                                default: break
                                }
                            }
                            conn.start(queue: .global(qos: .userInitiated))
                            // onCancel 竞态：若取消发生在 box.conn 赋值前，补一刀。
                            if Task.isCancelled { finish(.failure(CancellationError())) }
                        }
                    } onCancel: {
                        box.conn?.cancel()
                    }
                }
                group.addTask {
                    try await Task.sleep(nanoseconds: 4_000_000_000)
                    throw CancellationError()
                }
                try await group.next()
                group.cancelAll()
                // 排空：cancelAll 后 sleep 子任务会抛 CancellationError，
                // 不消费会在 group 退出时重新抛出，把成功误判成失败。
                while await group.nextResult() != nil {}
            }
            return Int(Date().timeIntervalSince(started) * 1000)
        } catch {
            return -1
        }
    }

    private final class NWConnectionBox: @unchecked Sendable {
        var conn: NWConnection?
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
            Self.blockingHTTPGet(handle: handle, target: Self.probeTarget, path: Self.probePath, budgetMS: 20_000)
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
        handle: TailscaleHandle, target: String, path: String, budgetMS: Int
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

        // poll 等可读，累计预算上限由调用方给（手动探针 20s；2.6 回前台复查 12s）。
        var received = Data()
        let totalBudgetMS = budgetMS
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
