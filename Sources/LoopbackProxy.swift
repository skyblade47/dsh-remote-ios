import Foundation
import Network

/// 方案 D / 4.5：设备本地 loopback 反代监听（设备无关半边）。
///
/// 在 127.0.0.1 上开 TCP listener（端口由内核动态分配），每收到一条连接：
/// 包成 NWConnectionChannel → 喂给 HttpBridge.handle（本地壳路由 / tailnet 上游桥）。
/// 启动成功后把实际 base URL（`http://127.0.0.1:<port>`）持久化到 UserDefaults，
/// 供 WKWebView 侧（Phase 5 改造）读取。
///
/// 上游仍由 HttpBridge 注入的 UpstreamConnecter 决定：模拟器测试注 FakeConnecter；
/// 真机 Phase 2.4/3.1 注 tailscale_dial 实现，本类不做任何 tailnet 假设。
final class LoopbackProxy {
    /// 实际 base URL 的持久化键（WKWebView 启动壳页面时读取）。
    static let baseURLDefaultsKey = "DSHLoopbackBaseURL"

    private let bridge: HttpBridge
    private let defaults: UserDefaults
    private var listener: NWListener?

    private let stateLock = NSLock()
    private var activeChannels: [NWConnectionChannel] = []
    private var portContinuation: CheckedContinuation<Int, Error>?
    /// bind 代际：每次 bind 自增。失败回退/复用端口会在同一 proxy 上发起第二任 bind，
    /// 旧 listener 迟到的 .cancelled 回调只能凭自己捕获的 gen 校验，gen 不符即丢弃，
    /// 不得误 resume 新一任 continuation。
    private var bindGeneration = 0

    init(bridge: HttpBridge, defaults: UserDefaults = .standard) {
        self.bridge = bridge
        self.defaults = defaults
    }

    /// 启动监听，阻塞到 ready 后返回实际 base URL（同时写入 UserDefaults）。
    ///
    /// - Parameter preferredPort: 6.1 回前台重建时优先复用的端口（WKWebView 已装壳，
    ///   同端口复用时壳无需换 base 重载）。该端口已被占用（极端情况）时自动回退到
    ///   内核动态端口，绝不起桥失败。nil（默认/首次）直接用动态端口。
    func start(preferredPort: UInt16? = nil) async throws -> URL {
        let port: Int
        do {
            port = try await bind(port: preferredPort ?? 0)
        } catch {
            // 首选端口绑定失败（被占用）：回退动态端口重建，而非把错误抛给调用方。
            guard let preferredPort, preferredPort != 0 else { throw error }
            port = try await bind(port: 0)
        }

        let base = URL(string: "http://127.0.0.1:\(port)")!
        defaults.set(base.absoluteString, forKey: Self.baseURLDefaultsKey)
        return base
    }

    /// 在 127.0.0.1 指定端口上 bind（0 = 内核动态分配），阻塞到 ready 返回实际端口。
    /// requiredLocalEndpoint 锁死 loopback，杜绝局域网/公网侧访问。
    private func bind(port: UInt16) async throws -> Int {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(
            host: NWEndpoint.Host("127.0.0.1"),
            port: NWEndpoint.Port(rawValue: port)!)
        let listener = try NWListener(using: parameters, on: .any)
        self.listener = listener

        // 本任 bind 的代际令牌：只允许这一任 listener 的回调结束本次 continuation。
        stateLock.lock()
        bindGeneration &+= 1
        let gen = bindGeneration
        stateLock.unlock()

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Int, Error>) in
            portContinuation = cont
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    if let port = listener.port?.rawValue {
                        self?.resumePort(gen, .success(Int(port)))
                    }
                case .failed(let error):
                    // 先以真实错误结束本任续体，再 cancel 释放失败 listener。顺序不可反：
                    // cancel 会在并发队列上再投递一次 .cancelled，先 resume 可让该迟到回调
                    // 被 gen 守卫丢弃，避免它把端口占用错报成 CancellationError。
                    self?.resumePort(gen, .failure(error))
                    listener.cancel()
                case .cancelled:
                    self?.resumePort(gen, .failure(CancellationError()))
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.start(queue: .global(qos: .userInitiated))
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
        stateLock.lock()
        let channels = activeChannels
        activeChannels.removeAll()
        stateLock.unlock()
        Task { for channel in channels { await channel.close() } }
    }

    // MARK: - 内部

    /// 结束某次 bind 的续体。仅当回调所属代际仍是当前代际（本次 bind 未被更新一任
    /// 取代、续体尚未 resume）时落地，避免旧 listener 的迟到回调误 resume 新 bind。
    private func resumePort(_ gen: Int, _ result: Result<Int, Error>) {
        stateLock.lock()
        guard gen == bindGeneration, let cont = portContinuation else {
            stateLock.unlock()
            return
        }
        portContinuation = nil
        stateLock.unlock()
        cont.resume(with: result)
    }

    private func accept(_ connection: NWConnection) {
        let channel = NWConnectionChannel(connection)
        stateLock.lock()
        activeChannels.append(channel)
        stateLock.unlock()
        channel.start()
        Task {
            await bridge.handle(channel)
            stateLock.lock()
            activeChannels.removeAll { $0 === channel }
            stateLock.unlock()
        }
    }
}
