import Foundation

/// 方案 D / 4.1：全双工字节通道抽象。
///
/// NWConnection + tailscale_dial 的真机实现见 Phase 2/3；
/// 模拟器单测用内存实现（Tests/InMemoryChannel.swift）顶替，桥接逻辑因此完全可测。
/// 实现方负责 EINTR 重试与流半关闭语义。
protocol DuplexChannel: AnyObject {
    /// 读一次；返回 nil 表示对端 FIN（半关闭）。
    func read() async throws -> Data?
    /// 写一次（需保证全部字节发出）。
    func write(_ data: Data) async throws
    /// 关闭本端（双向）。idempotent。
    func close() async
}

/// 上游连接抽象：按 host:port 建立一条全双工通道。
protocol UpstreamConnecter {
    func connect(host: String, port: Int) async throws -> DuplexChannel
}

enum BridgeError: Error, Equatable {
    case upstreamConnectFailed
}

/// 64KB 双向字节桥：client ↔ upstream 逐字节透传，覆盖 HTTP body / SSE / WS(101 后裸流)。
enum ByteBridge {
    static let chunkSize = 64 * 1024

    /// 启动双向拷贝。任一方向读到 FIN / 出错即整体收尾——半关闭联动全桥拆除，
    /// 避免另一方向永远阻塞；对端残留读由 close 产生的 EOF/错误唤醒。
    /// - Parameter initialClientBytes: 解析头部时多读出来的客户端首段，先补写给上游。
    static func run(client: DuplexChannel,
                    upstream: DuplexChannel,
                    initialClientBytes: Data = Data()) async {
        await withTaskGroup(of: Void.self) { group in
            group.addTask {
                await pump(from: client, to: upstream, initial: initialClientBytes)
            }
            group.addTask {
                await pump(from: upstream, to: client, initial: Data())
            }
            // 任一方向先结束即拆除（不等另一方向，它会被 close 唤醒退出）
            await group.next()
            group.cancelAll()
            await client.close()
            await upstream.close()
        }
    }

    private static func pump(from source: DuplexChannel,
                             to sink: DuplexChannel,
                             initial: Data) async {
        do {
            if !initial.isEmpty {
                try await sink.write(initial)
            }
            while true {
                guard let chunk = try await source.read() else { break }
                if chunk.isEmpty { continue }
                try await sink.write(chunk)
            }
        } catch {
            // 写失败或读异常：另一方向由 run() 统一 close 拆掉
        }
    }
}
