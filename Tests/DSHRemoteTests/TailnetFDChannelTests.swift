import Foundation
import Darwin
import XCTest
@testable import DSHRemote

// ============================================================================
// Phase 4.1 —— TailscaleFDChannel 单测：本地 socketpair(AF_UNIX/SOCK_STREAM) 顶替
// tailscale_dial 返回的 pipe fd。不经 tailnet、不引 Go，验证：
//   1. channel.write 大缓冲（跨多个 64KB 片、阻塞短写循环）字节无损到达对端；
//   2. 对端写入经 poll/read 循环被 channel.read 完整收回，对端 close 后 read 得 nil（FIN）；
//   3. 本地 close 立即拆除读循环（close(fd) → poll POLLNVAL），read 返回 nil、
//      再 write 被拒、close 幂等。
// EINTR 路径无法在单测里稳定制造，靠代码审计覆盖（read/write/poll 三处均 continue 重试）。
// ============================================================================

final class TailnetFDChannelTests: XCTestCase {

    // MARK: - helpers

    private func makeSocketPair() throws -> (channel: Int32, peer: Int32) {
        var fds = [Int32](repeating: -1, count: 2)
        let rc = socketpair(AF_UNIX, SOCK_STREAM, 0, &fds)
        if rc != 0 {
            throw NSError(domain: "TailnetFDChannelTests", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "socketpair 失败 errno=\(errno)"])
        }
        return (fds[0], fds[1])
    }

    /// 后台线程阻塞读满 count 字节（poll + read，EINTR 重试）。
    private func rawReadExact(_ fd: Int32, count: Int) async throws -> Data {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                var out = Data()
                out.reserveCapacity(count)
                var buf = [UInt8](repeating: 0, count: 64 * 1024)
                while out.count < count {
                    var pfd = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
                    let pr = poll(&pfd, 1, 5000)
                    if pr < 0 {
                        if errno == EINTR { continue }
                        cont.resume(throwing: TailnetConnectError.failed("peer poll errno=\(errno)"))
                        return
                    }
                    if pr == 0 {
                        cont.resume(throwing: TailnetConnectError.failed("peer 读超时"))
                        return
                    }
                    let n = buf.withUnsafeMutableBufferPointer {
                        Darwin.read(fd, $0.baseAddress, $0.count)
                    }
                    if n > 0 {
                        out.append(contentsOf: buf.prefix(n))
                        continue
                    }
                    if n == 0 { break } // 对端提前 EOF
                    if errno == EINTR { continue }
                    cont.resume(throwing: TailnetConnectError.failed("peer read errno=\(errno)"))
                    return
                }
                cont.resume(returning: out)
            }
        }
    }

    /// 后台线程阻塞全量写（EINTR / 短写循环），与产品写侧同构。
    private func rawWriteAll(_ fd: Int32, data: Data) async throws {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
            DispatchQueue.global(qos: .userInitiated).async {
                let result: Result<Void, Error> = data.withUnsafeBytes { raw in
                    guard let base = raw.bindMemory(to: UInt8.self).baseAddress else {
                        return .failure(TailnetConnectError.failed("peer write 缓冲不可用"))
                    }
                    var sent = 0
                    while sent < data.count {
                        let n = Darwin.write(fd, base.advanced(by: sent), data.count - sent)
                        if n < 0 {
                            if errno == EINTR { continue }
                            return .failure(TailnetConnectError.failed("peer write errno=\(errno)"))
                        }
                        sent += n
                    }
                    return .success(())
                }
                cont.resume(with: result)
            }
        }
    }

    // MARK: - 用例

    /// channel → peer：200KB（大于 socket 缓冲与 64KB 接收片）必须字节无损。
    func testLargeWriteArrivesByteExactAtPeer() async throws {
        let pair = try makeSocketPair()
        let channel = TailscaleFDChannel(fd: pair.channel)
        let total = 200_000
        let payload = Data((0..<total).map { UInt8($0 & 0xff) })

        async let received = rawReadExact(pair.peer, count: total)
        try await channel.write(payload)
        let got = try await received

        XCTAssertEqual(got.count, total)
        XCTAssertEqual(got, payload, "channel→peer 字节必须无损（含跨片/短写）")
        await channel.close()
        _ = Darwin.close(pair.peer)
    }

    /// peer → channel：对端写入经 poll/read 循环完整收回；对端 close 后 read 得 nil（FIN）。
    func testPeerToChannelByteExactThenEOF() async throws {
        let pair = try makeSocketPair()
        let channel = TailscaleFDChannel(fd: pair.channel)
        let total = 100_000
        let payload = Data((0..<total).map { UInt8(($0 * 7 + 3) & 0xff) })

        try await rawWriteAll(pair.peer, data: payload)

        var received = Data()
        while received.count < total {
            guard let chunk = try await channel.read() else {
                return XCTFail("收齐前不应 EOF，已收 \(received.count)/\(total)")
            }
            received.append(chunk)
        }
        XCTAssertEqual(received, payload, "peer→channel 字节必须无损")

        // 对端半关闭：read 必须以 nil 告知 FIN（n==0 路径）。
        _ = Darwin.close(pair.peer)
        let eof = try await channel.read()
        XCTAssertNil(eof, "对端 close 后 read 必须返回 nil（FIN 半关闭）")
        await channel.close()
    }

    /// 本地 close：读循环立即拆除（不靠 1s poll 节拍）、read 得 nil、write 被拒、close 幂等。
    func testLocalCloseTearsDownAndRejectsWrite() async throws {
        let pair = try makeSocketPair()
        let channel = TailscaleFDChannel(fd: pair.channel)
        _ = Darwin.close(pair.peer) // 本用例不从对端收发，先关避免 fd 泄漏

        let closed = expectation(description: "close 返回")
        Task {
            await channel.close()
            closed.fulfill()
        }
        await fulfillment(of: [closed], timeout: 2)

        // close(fd) 使 poll 立即 POLLNVAL：read 应迅速得 nil（远小于 1s 节拍）。
        let readDone = expectation(description: "read 返回 nil")
        Task {
            let chunk = try? await channel.read()
            if chunk == nil { readDone.fulfill() }
        }
        await fulfillment(of: [readDone], timeout: 2)

        do {
            try await channel.write(Data("x".utf8))
            XCTFail("close 后 write 必须抛错")
        } catch TailnetConnectError.failed(let reason) {
            XCTAssertTrue(reason.contains("已关闭"), "实际原因：\(reason)")
        }

        // 幂等：再关一次立即返回、不崩。
        await channel.close()
    }

    /// 空数据 write 是无操作，不碰 fd。
    func testEmptyWriteIsNoOp() async throws {
        let pair = try makeSocketPair()
        let channel = TailscaleFDChannel(fd: pair.channel)
        try await channel.write(Data())
        await channel.close()
        _ = Darwin.close(pair.peer)
    }
}
