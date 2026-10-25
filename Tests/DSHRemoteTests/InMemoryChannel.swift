import Foundation
@testable import DSHRemote

/// 测试用 Bundle 锚点：Tests target 把 ShellAssets 作为 resources 打入。
final class BundleMarker {}

/// 内存全双工通道对：顶替 NWConnection + tailscale_dial，
/// 让 ByteBridge / HttpBridge 的全部逻辑在模拟器单测内闭环（方案 D / 4.7）。
final class InMemoryChannel: DuplexChannel {
    private var continuation: AsyncStream<Data?>.Continuation
    private let stream: AsyncStream<Data?>
    private var iterator: AsyncStream<Data?>.Iterator?
    private weak var peerChannel: InMemoryChannel?
    private let lock = NSLock()
    private var isClosed = false

    init() {
        (stream, continuation) = AsyncStream.makeStream(of: Data?.self,
                                                        bufferingPolicy: .unbounded)
    }

    /// 返回 (a, b)：a 写入的数据进入 b 的读队列，反之亦然。
    static func makePair() -> (InMemoryChannel, InMemoryChannel) {
        let a = InMemoryChannel()
        let b = InMemoryChannel()
        a.peerChannel = b
        b.peerChannel = a
        return (a, b)
    }

    func read() async throws -> Data? {
        if iterator == nil { iterator = stream.makeAsyncIterator() }
        guard let element = await iterator?.next() else { return nil }
        return element
    }

    func write(_ data: Data) async throws {
        lock.lock()
        let closed = isClosed
        lock.unlock()
        if closed {
            throw NSError(domain: "InMemoryChannel", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "write after close"
            ])
        }
        peerChannel?.continuation.yield(data)
    }

    func close() async {
        lock.lock()
        if isClosed {
            lock.unlock()
            return
        }
        isClosed = true
        lock.unlock()
        // 双向关闭：对端读者收到 FIN(nil)，本端读流结束。
        peerChannel?.continuation.yield(nil)
        continuation.finish()
    }
}
