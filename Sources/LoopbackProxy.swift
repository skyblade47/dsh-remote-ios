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

    init(bridge: HttpBridge, defaults: UserDefaults = .standard) {
        self.bridge = bridge
        self.defaults = defaults
    }

    /// 启动监听，阻塞到 ready 后返回实际 base URL（同时写入 UserDefaults）。
    func start() async throws -> URL {
        // requiredLocalEndpoint 锁死 loopback，杜绝局域网/公网侧访问；端口 .any 由内核分配。
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(
            host: NWEndpoint.Host("127.0.0.1"),
            port: NWEndpoint.Port(rawValue: 0)!)
        let listener = try NWListener(using: parameters, on: .any)
        self.listener = listener

        let port = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Int, Error>) in
            portContinuation = cont
            listener.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    if let port = listener.port?.rawValue {
                        self?.resumePort(.success(Int(port)))
                    }
                case .failed(let error):
                    self?.resumePort(.failure(error))
                case .cancelled:
                    self?.resumePort(.failure(CancellationError()))
                default:
                    break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                self?.accept(connection)
            }
            listener.start(queue: .global(qos: .userInitiated))
        }

        let base = URL(string: "http://127.0.0.1:\(port)")!
        defaults.set(base.absoluteString, forKey: Self.baseURLDefaultsKey)
        return base
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

    private func resumePort(_ result: Result<Int, Error>) {
        stateLock.lock()
        let cont = portContinuation
        portContinuation = nil
        stateLock.unlock()
        cont?.resume(with: result)
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
