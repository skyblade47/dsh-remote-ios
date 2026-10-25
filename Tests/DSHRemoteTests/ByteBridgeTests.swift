import XCTest
@testable import DSHRemote

final class ByteBridgeTests: XCTestCase {
    /// 拓扑：clientApp ↔ clientProxy ==桥== upProxy ↔ upApp
    /// 验证 64KB 双向字节无损 + initial 首段 + 单向 FIN 全桥拆除。
    func testBidirectionalBytesInitialPrefaceAndTeardown() async throws {
        let (clientApp, clientProxy) = InMemoryChannel.makePair()
        let (upProxy, upApp) = InMemoryChannel.makePair()

        let bridgeTask = Task {
            await ByteBridge.run(client: clientProxy, upstream: upProxy,
                                 initialClientBytes: Data("PREFACE:".utf8))
        }

        // 1) initial 首段先到达上游，且先于后续客户端字节
        let preface = try await readExact(upApp, bytes: 8)
        XCTAssertEqual(String(decoding: preface, as: UTF8.self), "PREFACE:")

        // 2) client → upstream：20 万字节跨越多个 64KB 块
        let upPayload = cyclicPattern(seed: 0x11, count: 200_000)
        try await clientApp.write(upPayload)
        let upReceived = try await readExact(upApp, bytes: 200_000)
        XCTAssertEqual(upReceived, upPayload)

        // 3) upstream → client：反向 20 万字节
        let downPayload = cyclicPattern(seed: 0xa3, count: 200_000)
        try await upApp.write(downPayload)
        let downReceived = try await readExact(clientApp, bytes: 200_000)
        XCTAssertEqual(downReceived, downPayload)

        // 4) 上游 FIN → 全桥拆除，客户端读到 EOF
        await upApp.close()
        let eof = try await clientApp.read()
        XCTAssertNil(eof, "上游关闭后客户端应读到 EOF")

        _ = await bridgeTask.result
    }

    // MARK: - helpers

    private func readExact(_ ch: InMemoryChannel, bytes: Int) async throws -> Data {
        var buffer = Data()
        while buffer.count < bytes {
            guard let chunk = try await ch.read() else {
                throw NSError(domain: "ByteBridgeTests", code: 2, userInfo: [
                    NSLocalizedDescriptionKey:
                        "提前 EOF：已读 \(buffer.count)/\(bytes)"
                ])
            }
            buffer.append(chunk)
        }
        return buffer.prefix(bytes)
    }

    private func cyclicPattern(seed: UInt8, count: Int) -> Data {
        Data((0..<count).map { UInt8((Int(seed) + $0) & 0xff) })
    }
}
