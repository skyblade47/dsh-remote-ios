import XCTest
@testable import DSHRemote

final class OutboxStoreTests: XCTestCase {

    var dir: URL!
    var store: OutboxStore!
    var file: URL { dir.appendingPathComponent("outbox.json") }
    var tmpFile: URL { dir.appendingPathComponent("outbox.json.tmp") }

    override func setUpWithError() throws {
        try super.setUpWithError()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("OutboxTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        store = OutboxStore(dataDir: dir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        try super.tearDownWithError()
    }

    func assertAddBad(_ relPath: String?, _ fragment: String,
                       file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try store.add(relPath), file: file, line: line) { err in
            let desc = (err as? LocalizedError)?.errorDescription ?? String(describing: err)
            XCTAssertTrue(desc.contains(fragment),
                          "预期错误信息含「\(fragment)」，实际：\(desc)",
                          file: file, line: line)
        }
    }

    func readRaw(_ text: String) throws {
        try Data(text.utf8).write(to: file)
    }

    // MARK: - 缺失文件

    func testListMissingFileIsEmpty() {
        XCTAssertTrue(store.list().isEmpty)
        XCTAssertEqual(store.count(), 0)
        XCTAssertEqual(store.countByDoc(), [:])
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    // MARK: - add / 去重 / queuedAt

    func testAddWritesEntry() throws {
        try store.add("作品A/第一章.md")
        let list = store.list()
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0]["relPath"] as? String, "作品A/第一章.md")
        let at = list[0]["queuedAt"] as? Int64
        XCTAssertNotNil(at)
        XCTAssertGreaterThan(at ?? 0, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: tmpFile.path),
                       "提交后不得残留 outbox.json.tmp")
    }

    func testAddDeduplicatesByNormalizedRelPath() throws {
        try store.add(" 作品A/第一章.md ")
        try store.add("作品A/第一章.md")
        XCTAssertEqual(store.count(), 1)
        XCTAssertEqual(store.list()[0]["relPath"] as? String, "作品A/第一章.md")
    }

    func testAddNormalizesBackslashesAndDeduplicates() throws {
        try store.add("作品A\\第一章.md")
        try store.add("作品A/第一章.md")
        XCTAssertEqual(store.count(), 1)
        XCTAssertEqual(store.list()[0]["relPath"] as? String, "作品A/第一章.md")
    }

    func testAddKeepsInsertionOrderWhenTimestampsEqual() throws {
        try store.add("a.md")
        try store.add("b.md")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String }, ["a.md", "b.md"])
    }

    // MARK: - normalize 错误（逐字文案）

    func testAddRejectsNil() {
        assertAddBad(nil, "relPath 必须是字符串")
    }

    func testAddRejectsBlank() {
        assertAddBad("   ", "relPath 不得为空")
        assertAddBad("\t\n", "relPath 不得为空")
    }

    func testAddRejectsAbsolutePath() {
        assertAddBad("/作品A/第一章.md", "拒绝绝对路径: /作品A/第一章.md")
    }

    func testAddRejectsTrailingSlash() {
        assertAddBad("作品A/子目录/", "路径不得以分隔符结尾: 作品A/子目录/")
    }

    func testAddRejectsDotSegments() {
        assertAddBad("作品A/../第一章.md", "路径段不得为")
        assertAddBad("./第一章.md", "路径段不得为")
    }

    func testAddRejectsForbiddenSegment() {
        assertAddBad("作品A/第一:章.md", "禁用字符")
    }

    func testAddFailureDoesNotWriteFile() {
        assertAddBad("/x.md", "拒绝绝对路径")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    // MARK: - remove

    func testRemoveNullAndBlankAreNoOpWithoutWriting() {
        store.remove(nil)
        store.remove("   ")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }

    func testRemoveDeletesMatchingEntry() throws {
        try store.add("a.md")
        try store.add("b.md")
        store.remove("a.md")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String }, ["b.md"])
    }

    func testRemoveNormalizesBackslashesButDoesNotTrim() throws {
        try store.add("作品A/第一章.md")
        store.remove(" 作品A/第一章.md ")
        XCTAssertEqual(store.count(), 1, "remove 不做 trim，带空白不匹配")
        store.remove("作品A\\第一章.md")
        XCTAssertEqual(store.count(), 0)
    }

    func testRemoveUnknownIsNoOpAndDoesNotRewrite() throws {
        try store.add("a.md")
        let mtime = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate]
            as? Date
        Thread.sleep(forTimeInterval: 0.02)
        store.remove("不存在.md")
        let mtime2 = try FileManager.default.attributesOfItem(atPath: file.path)[.modificationDate]
            as? Date
        XCTAssertEqual(mtime, mtime2, "无变化不得重写文件")
    }

    func testRemoveDeletesAllDuplicatesInReverse() throws {
        try readRaw("[{\"relPath\":\"a.md\",\"queuedAt\":1},"
                    + "{\"relPath\":\"dup.md\",\"queuedAt\":2},"
                    + "{\"relPath\":\"dup.md\",\"queuedAt\":3}]")
        store.remove("dup.md")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String }, ["a.md"])
    }

    // MARK: - read 宽容与排序

    func testListSortsByQueuedAtAscending() throws {
        try readRaw("[{\"relPath\":\"c.md\",\"queuedAt\":30},"
                    + "{\"relPath\":\"a.md\",\"queuedAt\":10},"
                    + "{\"relPath\":\"b.md\",\"queuedAt\":20}]")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String },
                       ["a.md", "b.md", "c.md"])
    }

    func testListToleratesCorruptJson() throws {
        try readRaw("{这不是 JSON")
        XCTAssertTrue(store.list().isEmpty)
        XCTAssertEqual(store.count(), 0)
    }

    func testListToleratesNonArrayJson() throws {
        try readRaw("{\"relPath\":\"a.md\"}")
        XCTAssertTrue(store.list().isEmpty)
    }

    func testListSkipsBadEntriesAndDefaultsQueuedAt() throws {
        try readRaw("[42,"
                    + "{\"queuedAt\":5},"
                    + "{\"relPath\":\"  \",\"queuedAt\":6},"
                    + "{\"relPath\":\"x.md\"},"
                    + "{\"relPath\":\"y.md\",\"queuedAt\":\"abc\"}]")
        let list = store.list()
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(list[0]["relPath"] as? String, "x.md")
        XCTAssertEqual(list[0]["queuedAt"] as? Int64, 0)
        XCTAssertEqual(list[1]["relPath"] as? String, "y.md")
        XCTAssertEqual(list[1]["queuedAt"] as? Int64, 0)
    }

    func testListStripsBom() throws {
        try readRaw("\u{FEFF}[{\"relPath\":\"a.md\",\"queuedAt\":1}]")
        XCTAssertEqual(store.list().map { $0["relPath"] as? String }, ["a.md"])
    }

    func testListReturnsCopy() throws {
        try store.add("a.md")
        var snapshot = store.list()
        snapshot.removeAll()
        XCTAssertEqual(store.count(), 1)
    }

    // MARK: - countByDoc

    func testCountByDocGroupsBeforeFirstSlash() throws {
        try readRaw("[{\"relPath\":\"作品A/第一章.md\",\"queuedAt\":1},"
                    + "{\"relPath\":\"作品A/第二章.md\",\"queuedAt\":2},"
                    + "{\"relPath\":\"作品B/x.md\",\"queuedAt\":3},"
                    + "{\"relPath\":\"根文档.md\",\"queuedAt\":4}]")
        let counts = store.countByDoc()
        XCTAssertEqual(counts["作品A"], 2)
        XCTAssertEqual(counts["作品B"], 1)
        XCTAssertEqual(counts[""], 1)
        XCTAssertEqual(counts.keys.sorted(), ["", "作品A", "作品B"])
    }

    // MARK: - 落盘往返

    func testRoundTripAcrossInstances() throws {
        try store.add("作品A/第一章.md")
        let reopened = OutboxStore(dataDir: dir)
        XCTAssertEqual(reopened.count(), 1)
        XCTAssertEqual(reopened.list()[0]["relPath"] as? String, "作品A/第一章.md")
    }
}
