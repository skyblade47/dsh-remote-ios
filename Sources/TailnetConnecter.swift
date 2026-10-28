import Foundation
import Darwin
import TailscaleKit

// ============================================================================
// 方案 D / Phase 4.1 —— 真机上游：tailscale_dial 返回的 POSIX fd → DuplexChannel。
//
// 链路：WKWebView → http://127.0.0.1:<port>（LoopbackProxy/NWConnectionChannel）
//       → HttpBridge（剥 hop-by-hop、Host 重写 100.99.84.35:8080）
//       → TailnetDialConnecter（tailscale_dial 拿 pipe fd）
//       → TailscaleFDChannel → ByteBridge 64KB 双向裸透传（含 WS 101 后裸流）
//
// tailscale_dial 的 conn 是 pipe(2) fd：可直接 poll/read/write/close（不能 shutdown，
// pipe 不是 socket）。收侧用一条专用串行队列跑 poll(1s)/read 循环喂 AsyncStream，
// 与 NWConnectionChannel 同构；close 关 fd 后 poll 立即 POLLNVAL 唤醒收尾。
//
// 本文件是 4.1 唯一真机件：设备无关的桥逻辑（ByteBridge/HttpBridge/LoopbackProxy）
// 全部经 DuplexChannel/UpstreamConnecter 协议注入，模拟器单测用 InMemoryChannel/
// FakeUpstream，不经 tailnet；本文件的 fd 通道用本地 socketpair 单测（见 TailnetFDChannelTests）。
// ============================================================================

enum TailnetConnectError: Error, Equatable {
    /// 拨号失败 / 通道读写失败；关联值为人类可读原因（含 tailscale_errmsg / POSIX errno）。
    case failed(String)
}

/// tailscale_dial fd → DuplexChannel。read 走 AsyncStream 缓冲，write 为阻塞全量写。
final class TailscaleFDChannel: DuplexChannel {
    private let fd: Int32
    private let readQueue: DispatchQueue

    // 与 NWConnectionChannel 一致：init 即建无界接收流，首字节不丢。
    private let continuation: AsyncStream<Data?>.Continuation
    private let inbound: AsyncStream<Data?>
    private var iterator: AsyncStream<Data?>.Iterator?
    private let iteratorLock = NSLock()

    private let stateLock = NSLock()
    private var streamFinished = false
    private var closed = false

    init(fd: Int32) {
        self.fd = fd
        self.readQueue = DispatchQueue(label: "dsh.tailnet.fdchannel.\(fd)")
        var cont: AsyncStream<Data?>.Continuation!
        self.inbound = AsyncStream<Data?> { cont = $0 }
        self.continuation = cont
        readQueue.async { [weak self] in self?.readLoop() }
    }

    func read() async throws -> Data? {
        iteratorLock.lock()
        if iterator == nil { iterator = inbound.makeAsyncIterator() }
        var iter = iterator!
        iteratorLock.unlock()
        return await iter.next() ?? nil
    }

    func write(_ data: Data) async throws {
        guard !data.isEmpty else { return }
        stateLock.lock()
        let alreadyClosed = closed
        stateLock.unlock()
        if alreadyClosed { throw TailnetConnectError.failed("通道已关闭，write 被拒") }

        // 阻塞全量写（EINTR/短写循环）丢后台队列；同方向只有 ByteBridge 一个 pump，天然串行。
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                guard let self else { cont.resume(); return }
                let result: Result<Void, Error> = data.withUnsafeBytes { raw -> Result<Void, Error> in
                    guard let base = raw.bindMemory(to: UInt8.self).baseAddress else {
                        return .failure(TailnetConnectError.failed("write 缓冲不可用"))
                    }
                    var sent = 0
                    while sent < data.count {
                        let n = Darwin.write(self.fd, base.advanced(by: sent), data.count - sent)
                        if n < 0 {
                            if errno == EINTR { continue }
                            return .failure(TailnetConnectError.failed("write errno=\(errno)"))
                        }
                        sent += n
                    }
                    return .success(())
                }
                cont.resume(with: result)
            }
        }
    }

    func close() async {
        stateLock.lock()
        let already = closed
        closed = true
        stateLock.unlock()
        guard !already else { return }
        // pipe fd 不支持 shutdown；直接 close 让 poll 以 POLLNVAL 唤醒读循环。
        _ = Darwin.close(fd)
        finishStream()
    }

    // MARK: - 接收循环（专用串行队列，阻塞 poll/read）

    private func readLoop() {
        while true {
            stateLock.lock()
            let isClosed = closed
            stateLock.unlock()
            if isClosed { finishStream(); return }

            var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
            let pr = poll(&pfd, 1, 1000) // 1s 节拍：close 后最迟 1s（实测立即）退出
            if pr < 0 {
                if errno == EINTR { continue }
                finishStream()
                return
            }
            if pr == 0 { continue }

            // 先看 POLLIN：POLLHUP 时管道里可能仍有残余字节，读完下一轮再收尾。
            if (pfd.revents & Int16(POLLIN)) != 0 {
                var chunk = [UInt8](repeating: 0, count: ByteBridge.chunkSize)
                let n = chunk.withUnsafeMutableBufferPointer { buf -> Int in
                    Darwin.read(fd, buf.baseAddress, buf.count)
                }
                if n > 0 {
                    continuation.yield(Data(chunk.prefix(n)))
                    continue
                }
                if n == 0 { finishStream(); return } // 对端 FIN
                if errno == EINTR { continue }
                finishStream()
                return
            }
            // POLLHUP / POLLERR / POLLNVAL：读侧终结（与 NWConnectionChannel 一致统一降级 EOF）。
            finishStream()
            return
        }
    }

    private func finishStream() {
        stateLock.lock()
        let already = streamFinished
        streamFinished = true
        stateLock.unlock()
        guard !already else { return }
        continuation.yield(nil)
        continuation.finish()
    }
}

/// 进程内 tsnet 上游：每连接一次 tailscale_dial，fd 包成 TailscaleFDChannel。
/// host/port 由 HttpBridge 给定（生产 100.99.84.35:8080），本类不写死。
final class TailnetDialConnecter: UpstreamConnecter {
    private let handle: TailscaleHandle

    init(handle: TailscaleHandle) {
        self.handle = handle
    }

    func connect(host: String, port: Int) async throws -> DuplexChannel {
        let target = "\(host):\(port)"
        let handle = self.handle
        return try await Task.detached(priority: .userInitiated) {
            var conn: TailscaleConnection = -1
            let rc = tailscale_dial(handle, "tcp", target, &conn)
            if rc != 0 || conn < 0 {
                var buf = [CChar](repeating: 0, count: 256)
                _ = tailscale_errmsg(handle, &buf, buf.count)
                throw TailnetConnectError.failed(
                    "tailscale_dial rc=\(rc) err=\(String(cString: buf))")
            }
            return TailscaleFDChannel(fd: conn)
        }.value
    }
}
