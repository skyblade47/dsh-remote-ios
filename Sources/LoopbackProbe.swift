import Foundation
import Network

/// 方案 D / 6.1：回前台探活外挂 loopback 桥。
///
/// Phase 2.6 真机结论：iOS 挂起回收的是外挂的 NWListener（tsnet 节点本身存活）。
/// 回前台**不重 up 节点**，只探活 127.0.0.1 桥端口：
/// - 能建立 TCP 连接（listener 仍在）即判桥活——哪怕上游 tailnet 此刻不通，
///   桥本身也会以 502 应答，TCP 层面照样 ready；上游通断属 6.2 三档/6.3 drain 语义，
///   不在此探活范围内。
/// - URL 非法 / 拒连 / 超时一律 false，不卡死、不假装活。
enum LoopbackProbe {
    /// 探活超时：回前台是用户正盯着的路径，宁快勿等；建连失败即触发同端口优先重建。
    static let timeout: TimeInterval = 0.8

    static func isAlive(base: String) async -> Bool {
        guard let url = URL(string: base),
              let host = url.host,
              let portValue = url.port,
              // url.port 是 Int；NWEndpoint.Port 要 UInt16。exactly 杜绝非法端口值 trap。
              let rawPort = UInt16(exactly: portValue),
              let port = NWEndpoint.Port(rawValue: rawPort) else {
            return false
        }

        let connection = NWConnection(
            host: NWEndpoint.Host(host), port: port, using: .tcp)
        // 续体只允许 resume 一次（ready 后失败回调 / 超时任务可能竞争到达）。
        let gate = ProbeGate()

        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            gate.runOnce = { alive in
                connection.cancel()
                cont.resume(returning: alive)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    gate.resolve(true)
                case .failed, .cancelled:
                    gate.resolve(false)
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))

            // 看门狗：到点未 ready 即判死（cancel 连接，stateUpdateHandler 随之 .cancelled）。
            Task {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                gate.resolve(false)
            }
        }
    }

    /// 多个异步来源（ready/failed/cancelled/超时）竞争下保证续体只落地一次。
    private final class ProbeGate: @unchecked Sendable {
        private let lock = NSLock()
        private var resolved = false
        var runOnce: ((Bool) -> Void)?

        func resolve(_ alive: Bool) {
            lock.lock()
            if resolved {
                lock.unlock()
                return
            }
            resolved = true
            let work = runOnce
            lock.unlock()
            work?(alive)
        }
    }
}
