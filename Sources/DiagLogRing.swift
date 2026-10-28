import Foundation

/// S1 真机诊断（DIAG-D，临时）：记录「真正到达 loopback listener」的请求轨迹。
///
/// 进程内环形缓冲（最多 200 条），由 HttpBridge 在读出请求头后写入，
/// 经 `/diag-log` 本地端点读取/清空。用途：从反代进程内部判定
/// WKWebView 发出的哪些路径真正建立了 TCP 连接、哪些在网络栈外就被拦。
/// 收尾时随 /diag-log、/__shell__/diag 一并删除。
final class DiagLogRing: @unchecked Sendable {
    static let shared = DiagLogRing()

    private let lock = NSLock()
    private var entries: [String] = []
    private let limit = 200

    func append(_ entry: String) {
        lock.lock()
        entries.append(entry)
        if entries.count > limit { entries.removeFirst(entries.count - limit) }
        lock.unlock()
    }

    func snapshot() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return entries
    }

    func clear() {
        lock.lock()
        entries.removeAll()
        lock.unlock()
    }
}
