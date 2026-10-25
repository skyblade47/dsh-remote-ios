import Foundation
import Network

/// 方案 D / 4.5：NWConnection → DuplexChannel 适配（设备无关半边）。
///
/// 同一份实现承担两端角色：
/// - LoopbackProxy 接受的客户端连接（NWListener.newConnection）；
/// - Phase 2/3 真机 tailscale_dial 拨出的上游连接（fd 桥接成 NWConnection 后同构接入）。
///
/// 接收侧用 AsyncStream 续体化 NWConnection 的 completion 回调；读错误统一降级为
/// 流终结（nil），与 FIN 同效——桥接层对两种 EOF 的处理本就一致（拆桥）。
final class NWConnectionChannel: DuplexChannel {
    private let connection: NWConnection

    // 接收流在 init 时即建好（默认无界缓冲）：字节可能在首个 read() 前到达，不能丢。
    private let continuation: AsyncStream<Data?>.Continuation
    private let inbound: AsyncStream<Data?>
    private var iterator: AsyncStream<Data?>.Iterator?
    private let iteratorLock = NSLock()

    private let finishLock = NSLock()
    private var streamFinished = false
    private var closed = false

    init(_ connection: NWConnection) {
        self.connection = connection
        var cont: AsyncStream<Data?>.Continuation!
        self.inbound = AsyncStream<Data?> { cont = $0 }
        self.continuation = cont
    }

    /// 在 start(queue:) 之后调用：注册首次 receive。
    /// 必须在任何 write 之前完成，否则首个请求字节到达时接收循环可能尚未就绪。
    func start() {
        connection.start(queue: .global(qos: .userInitiated))
        scheduleReceive()
    }

    func read() async throws -> Data? {
        iteratorLock.lock()
        if iterator == nil { iterator = inbound.makeAsyncIterator() }
        var iter = iterator!
        iteratorLock.unlock()
        return await iter.next() ?? nil
    }

    func write(_ data: Data) async throws {
        guard !closed, !data.isEmpty else { return }
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            connection.send(content: data, completion: .contentProcessed { error in
                if let error { cont.resume(throwing: error) } else { cont.resume() }
            })
        }
    }

    func close() async {
        finishLock.lock()
        let already = closed
        closed = true
        finishLock.unlock()
        guard !already else { return }
        connection.cancel()
        finishStream()
    }

    // MARK: - 接收循环

    private func scheduleReceive() {
        connection.receive(minimumIncompleteLength: 1,
                           maximumLength: ByteBridge.chunkSize) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            if let data, !data.isEmpty {
                self.continuation.yield(data)
            }
            if error != nil || isComplete {
                self.finishStream()
                return
            }
            self.scheduleReceive()
        }
    }

    /// 终结接收流（yield(nil) 让挂起的 read 立刻返回 EOF，再 finish 释放续体）。
    private func finishStream() {
        finishLock.lock()
        let already = streamFinished
        streamFinished = true
        finishLock.unlock()
        guard !already else { return }
        continuation.yield(nil)
        continuation.finish()
    }
}
