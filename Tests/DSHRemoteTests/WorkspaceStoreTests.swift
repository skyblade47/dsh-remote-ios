import XCTest
@testable import DSHRemote

final class WorkspaceStoreTests: XCTestCase {

    var root: URL!
    var ws: WorkspaceStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("WorkspaceTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        ws = WorkspaceStore(root: root)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        ws = nil
        root = nil
        try super.tearDownWithError()
    }

    func assertBad<T>(_ expression: @autoclosure () throws -> T,
                      _ fragment: String,
                   file: StaticString = #filePath,
                   line: UInt = #line) {
        XCTAssertThrowsError(try expression(), file: file, line: line) { err in
            let desc = (err as? LocalizedError)?.errorDescription ?? String(describing: err)
            XCTAssertTrue(desc.contains(fragment),
                          "预期错误信息含「\(fragment)」，实际：\(desc)",
                          file: file, line: line)
        }
    }

    @discardableResult
    func mkDoc(_ work: String, _ name: String, _ content: String = "") throws -> [String: Any] {
        try ws.createWork(work)
        return try ws.writeDoc(relPath: "\(work)/\(name)", content: content)
    }

    func works(_ r: [String: Any]) -> [[String: Any]] {
        (r["works"] as? [[String: Any]]) ?? []
    }

    func testEmptyWorkspace() throws {
        let r = try ws.listWorkspace()
        XCTAssertTrue((r["ok"] as? Bool) == true)
        XCTAssertEqual(r["root"] as? String, root.path)
        XCTAssertEqual(works(r).count, 0)
    }

    func testListIgnoresHiddenDotFilesAndTrashAndNonMd() throws {
        _ = try mkDoc("作品A", "a.md", "你好")
        FileManager.default.createFile(atPath: root.appendingPathComponent(".secret").path,
                                      contents: Data())
        FileManager.default.createFile(atPath: root.appendingPathComponent("loose.txt").path,
                                      contents: Data())
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(".hiddenDir"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent(PathGuard.trashDir), withIntermediateDirectories: true)

        let r = try ws.listWorkspace()
        XCTAssertEqual(works(r).map { $0["name"] as? String }, ["作品A"])
        let docs = works(r)[0]["docs"] as? [[String: Any]]
        XCTAssertEqual(docs?.map { $0["name"] as? String }, ["a.md"])
        XCTAssertEqual(docs?[0]["relPath"] as? String, "作品A/a.md")
        XCTAssertTrue((docs?[0]["mtime"] as? NSNumber)?.int64Value ?? 0 > 0)

        FileManager.default.createFile(
            atPath: root.appendingPathComponent("作品A/note.txt").path, contents: Data())
        let r2 = try ws.listWorkspace()
        let docs2 = works(r2)[0]["docs"] as? [[String: Any]]
        XCTAssertEqual(docs2?.count, 1)
    }

    func testWriteThenRead() throws {
        _ = try mkDoc("作品A", "a.md", "正文内容")
        let r = try ws.readDoc(relPath: "作品A/a.md")
        XCTAssertTrue((r["ok"] as? Bool) == true)
        XCTAssertEqual(r["content"] as? String, "正文内容")
        XCTAssertTrue((r["mtime"] as? NSNumber)?.int64Value ?? 0 > 0)
    }

    func testWriteResultKeys() throws {
        try ws.createWork("作品A")
        let r = try ws.writeDoc(relPath: "作品A/a.md", content: "abc")
        XCTAssertTrue((r["ok"] as? Bool) == true)
        XCTAssertTrue((r["mtime"] as? NSNumber)?.int64Value ?? 0 > 0)
        XCTAssertEqual(r["bytes"] as? Int, 3)
    }

    func testWriteStripsBomOnReadButPreservesWrittenUtf8() throws {
        try ws.createWork("作品A")
        try ws.writeDoc(relPath: "作品A/a.md", content: "\u{FEFF}带BOM")
        let r = try ws.readDoc(relPath: "作品A/a.md")
        XCTAssertEqual(r["content"] as? String, "带BOM")
    }

    func testWriteOversizeRejected() throws {
        try ws.createWork("作品A")
        let big = String(repeating: "a", count: 2 * 1024 * 1024 + 1)
        assertBad(try ws.writeDoc(relPath: "作品A/a.md", content: big), "文档过大")
    }

    func testWriteNullContentAndBadExt() throws {
        try ws.createWork("作品A")
        assertBad(try ws.writeDoc(relPath: "作品A/a.md", content: nil as String?),
                  "内容必须是字符串")
        assertBad(try ws.writeDoc(relPath: "作品A/a.txt", content: "x"), "只允许 .md")
    }

    func testCreateWorkDuplicate() throws {
        _ = try ws.createWork("作品A")
        assertBad(try ws.createWork("作品A"), "已存在")
    }

    func testCreateDocEmptyFileAndDuplicate() throws {
        try ws.createWork("作品A")
        let r = try ws.createDoc(work: "作品A", name: "新文档")
        XCTAssertTrue((r["ok"] as? Bool) == true)
        XCTAssertEqual(r["relPath"] as? String, "作品A/新文档.md")
        let read = try ws.readDoc(relPath: "作品A/新文档.md")
        XCTAssertEqual(read["content"] as? String, "")
        assertBad(try ws.createDoc(work: "作品A", name: "新文档"), "已存在")
    }

    func testRenameWork() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let r = try ws.renameWork(oldName: "作品A", newName: "作品B")
        XCTAssertEqual(r["work"] as? String, "作品B")
        let same = try ws.renameWork(oldName: "作品B", newName: "作品B")
        XCTAssertEqual(same["work"] as? String, "作品B")
        XCTAssertNoThrow(try ws.readDoc(relPath: "作品B/a.md"))
        assertBad(try ws.renameWork(oldName: "作品B", newName: "作品C/.."), "禁用字符")
    }

    func testRenameDoc() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let r = try ws.renameDoc(work: "作品A", oldName: "a.md", newName: "b.md")
        XCTAssertEqual(r["relPath"] as? String, "作品A/b.md")
        let same = try ws.renameDoc(work: "作品A", oldName: "b.md", newName: "b.md")
        XCTAssertEqual(same["relPath"] as? String, "作品A/b.md")
        assertBad(try ws.renameDoc(work: "作品A", oldName: "b.txt", newName: "x.md"),
                  "只允许")
    }

    func testMoveDoc() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        try ws.createWork("作品B")
        let r = try ws.moveDoc(fromWork: "作品A", name: "a.md", toWork: "作品B")
        XCTAssertEqual(r["relPath"] as? String, "作品B/a.md")
        XCTAssertEqual(r["moved"] as? Bool, true)
        assertBad(try ws.readDoc(relPath: "作品A/a.md"), "不是文件")
        let back = try ws.moveDoc(fromWork: "作品B", name: "a.md", toWork: "作品B")
        XCTAssertEqual(back["moved"] as? Bool, false)
        assertBad(try ws.moveDoc(fromWork: "作品B", name: "missing.md", toWork: "作品A"),
                  "文档不存在")
    }

    func testTrashDocListRestore() throws {
        _ = try mkDoc("作品A", "日记.md", "x")
        let t = try ws.trashDoc(work: "作品A", name: "日记.md")
        XCTAssertTrue((t["ok"] as? Bool) == true)
        XCTAssertTrue((t["relPath"] as? String ?? "").hasPrefix("\(PathGuard.trashDir)/作品A/日记-"))

        let lr = try ws.listTrash()
        let items = (lr["items"] as? [[String: Any]]) ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0]["kind"] as? String, "doc")
        XCTAssertEqual(items[0]["name"] as? String, "日记.md")
        XCTAssertEqual(items[0]["work"] as? String, "作品A")
        let trashName = items[0]["trashName"] as? String ?? ""
        XCTAssertNotNil(trashName.range(of: #"^日记-\d{8}-\d{6}\.md$"#,
                                       options: .regularExpression))
        XCTAssertEqual(items[0]["relPath"] as? String, t["relPath"] as? String)

        let restored = try ws.restoreTrash(relPath: t["relPath"] as! String)
        XCTAssertEqual(restored["kind"] as? String, "doc")
        XCTAssertEqual(restored["relPath"] as? String, "作品A/日记.md")
        XCTAssertNoThrow(try ws.readDoc(relPath: "作品A/日记.md"))
    }

    func testTrashWorkListRestore() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let t = try ws.trashWork(name: "作品A")
        let lr = try ws.listTrash()
        let items = (lr["items"] as? [[String: Any]]) ?? []
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0]["kind"] as? String, "work")
        XCTAssertEqual(items[0]["name"] as? String, "作品A")
        XCTAssertEqual(items[0]["work"] as? NSNull, NSNull())

        let restored = try ws.restoreTrash(relPath: t["relPath"] as! String)
        XCTAssertEqual(restored["kind"] as? String, "work")
        XCTAssertEqual(restored["work"] as? String, "作品A")
        XCTAssertNoThrow(try ws.readDoc(relPath: "作品A/a.md"))
    }

    func testListTrashSortedByMtimeDesc() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        _ = try ws.trashDoc(work: "作品A", name: "a.md")
        Thread.sleep(forTimeInterval: 0.02)
        _ = try ws.writeDoc(relPath: "作品A/b.md", content: "y")
        _ = try ws.trashDoc(work: "作品A", name: "b.md")
        let items = (try ws.listTrash())["items"] as? [[String: Any]]
        XCTAssertEqual(items?.map { $0["name"] as? String }, ["b.md", "a.md"])
    }

    func testRestoreErrors() throws {
        assertBad(try ws.restoreTrash(relPath: "作品A/a.md"), "回收站条目不存在")
        _ = try mkDoc("作品A", "a.md", "x")
        assertBad(try ws.restoreTrash(relPath: "作品A/a.md"), "不是回收站内的条目")
    }

    func testRestoreWorkConflict() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let t = try ws.trashWork(name: "作品A")
        _ = try ws.createWork("作品A")
        assertBad(try ws.restoreTrash(relPath: t["relPath"] as! String), "无法恢复")
    }

    func testPurgeTrash() throws {
        _ = try mkDoc("作品A", "a.md", "x")
        let t = try ws.trashDoc(work: "作品A", name: "a.md")
        let rel = t["relPath"] as! String
        let p = try ws.purgeTrash(relPath: rel)
        XCTAssertEqual(p["relPath"] as? String, rel)
        XCTAssertTrue(((try ws.listTrash())["items"] as? [[String: Any]])?.isEmpty ?? true)
        assertBad(try ws.purgeTrash(relPath: rel), "回收站条目不存在")
        assertBad(try ws.purgeTrash(relPath: "作品A/a.md"), "只能彻底删除")
    }

    func testReadMissingIsNotFile() throws {
        try ws.createWork("作品A")
        assertBad(try ws.readDoc(relPath: "作品A/missing.md"), "不是文件")
    }
}
