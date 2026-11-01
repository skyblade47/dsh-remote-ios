import XCTest
@testable import DSHRemote

// ============================================================================
// Phase 6.3 —— 待发箱只读计数（上传同步北极星的真机可观测性）。
//
// 验收要点：iPad 单设备、无 Mac Web Inspector，必须能在设置页直接看到
// 「断网编辑入队 N 条 → 回网 drain → 归零」。OutboxCounter 与 BridgeDispatcher
// 是**不同实例但读同一 Documents/outbox.json**，故这里的写入方一律另建一个
// OutboxStore（模拟 BridgeDispatcher 的 add/remove），验证跨实例文件可见性。
//
// 时序纪律（接 6.2 轮询测试的教训）：只测确定性的 refresh()/start 立即刷新/
// start-stop 幂等，**不靠 sleep 等定时器跳变**（避免 CI 模拟器主队列拥塞 flaky）。
// ============================================================================

@MainActor
final class OutboxCounterTests: XCTestCase {

    var dir: URL!
    /// 模拟 BridgeDispatcher：与被测 counter 不同实例、指向同一 outbox.json。
    var writer: OutboxStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("OutboxCounterTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        writer = OutboxStore(dataDir: dir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        try super.tearDownWithError()
    }

    func testRefreshReflectsWritesFromAnotherInstance() throws {
        try writer.add("作品A/第一章.md")
        try writer.add("作品A/第二章.md")
        try writer.add("作品B/x.md")

        let counter = OutboxCounter(dataDir: dir, pollInterval: 100)
        counter.refresh()

        XCTAssertEqual(counter.pendingCount, 3)
        XCTAssertEqual(counter.countByDoc["作品A"], 2)
        XCTAssertEqual(counter.countByDoc["作品B"], 1)
    }

    func testRefreshGoesToZeroAfterExternalRemove() throws {
        try writer.add("a.md")
        try writer.add("b.md")
        let counter = OutboxCounter(dataDir: dir)
        counter.refresh()
        XCTAssertEqual(counter.pendingCount, 2)

        writer.remove("a.md")
        writer.remove("b.md")
        counter.refresh()

        XCTAssertEqual(counter.pendingCount, 0)
        XCTAssertTrue(counter.countByDoc.isEmpty)
    }

    func testMissingFileReportsZero() {
        let counter = OutboxCounter(dataDir: dir)
        counter.refresh()
        XCTAssertEqual(counter.pendingCount, 0)
        XCTAssertTrue(counter.countByDoc.isEmpty)
    }

    func testStartRefreshesImmediatelyWithoutWaitingInterval() throws {
        try writer.add("x.md")
        let counter = OutboxCounter(dataDir: dir, pollInterval: 100)
        counter.start()
        // 进入设置页应立刻看到当前值，而不是等首个轮询间隔。
        XCTAssertEqual(counter.pendingCount, 1)
    }

    func testStartAndStopAreIdempotent() throws {
        try writer.add("x.md")
        let counter = OutboxCounter(dataDir: dir, pollInterval: 100)
        counter.start()
        counter.start()   // 重复 start 不得叠加第二个轮询循环
        XCTAssertEqual(counter.pendingCount, 1)
        counter.stop()
        counter.stop()    // 重复 stop 安全
    }

    func testRestartAfterStopPicksUpNewWrites() throws {
        let counter = OutboxCounter(dataDir: dir, pollInterval: 100)
        counter.start()
        counter.stop()
        XCTAssertEqual(counter.pendingCount, 0)

        try writer.add("y.md")
        counter.start()
        XCTAssertEqual(counter.pendingCount, 1)
        counter.stop()
    }
}
