import XCTest
@testable import DSHRemote

final class PathGuardTests: XCTestCase {

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

    func makeTempRoot() throws -> URL {
        let d = FileManager.default.temporaryDirectory
            .appendingPathComponent("PathGuardTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        return d
    }

    func testConstants() {
        XCTAssertEqual(PathGuard.trashDir, "_回收")
        XCTAssertEqual(PathGuard.workTrashSub, "_作品")
        XCTAssertEqual(PathGuard.maxSegment, 120)
    }

    func testValidateSegmentAccepts() throws {
        XCTAssertEqual(try PathGuard.validateSegment("作品A"), "作品A")
        XCTAssertEqual(try PathGuard.validateSegment("我的文档.md"), "我的文档.md")
        let boundary = String(repeating: "a", count: 120)
        XCTAssertEqual(try PathGuard.validateSegment(boundary), boundary)
    }

    func testValidateSegmentRejects() {
        assertBad(try PathGuard.validateSegment(nil), "名称必须是字符串")
        assertBad(try PathGuard.validateSegment(""), "名称不得为空")
        assertBad(try PathGuard.validateSegment("."), "路径段不得为")
        assertBad(try PathGuard.validateSegment(".."), "路径段不得为")
        assertBad(try PathGuard.validateSegment("a/b"), "禁用字符")
        assertBad(try PathGuard.validateSegment("a\\b"), "禁用字符")
        assertBad(try PathGuard.validateSegment("a:b"), "禁用字符")
        assertBad(try PathGuard.validateSegment("a*?"), "禁用字符")
        assertBad(try PathGuard.validateSegment("a|<>\""), "禁用字符")
        assertBad(try PathGuard.validateSegment("a\u{0}b"), "禁用字符")
        assertBad(try PathGuard.validateSegment(" a"), "首尾不得有空白")
        assertBad(try PathGuard.validateSegment("a\t"), "首尾不得有空白")
        assertBad(try PathGuard.validateSegment("a "), "首尾不得有空白")
        assertBad(try PathGuard.validateSegment("a."), "不得以点或空格结尾")
        assertBad(try PathGuard.validateSegment(String(repeating: "a", count: 121)),
                  "名称过长")
        assertBad(try PathGuard.validateSegment("CON"), "保留设备名")
        assertBad(try PathGuard.validateSegment("prn"), "保留设备名")
        assertBad(try PathGuard.validateSegment("Com1"), "保留设备名")
        assertBad(try PathGuard.validateSegment("lpt9.md"), "保留设备名")
        assertBad(try PathGuard.validateSegment("nul.txt"), "保留设备名")
    }

    func testSplitRel() throws {
        XCTAssertEqual(try PathGuard.splitRel("作品A/文档.md"), ["作品A", "文档.md"])
        XCTAssertEqual(try PathGuard.splitRel("作品A\\文档.md"), ["作品A", "文档.md"])
        XCTAssertEqual(try PathGuard.splitRel("a//b/"), ["a", "b"])
        assertBad(try PathGuard.splitRel(nil), "路径为空")
        assertBad(try PathGuard.splitRel(""), "路径为空")
        assertBad(try PathGuard.splitRel("/a/b"), "绝对路径")
        assertBad(try PathGuard.splitRel("\\a"), "绝对路径")
        assertBad(try PathGuard.splitRel("C:/a"), "盘符路径")
        assertBad(try PathGuard.splitRel("d:\\a"), "盘符路径")
    }

    func testMdHelpers() throws {
        XCTAssertTrue(PathGuard.hasMdExt("a.md"))
        XCTAssertTrue(PathGuard.hasMdExt("A.MD"))
        XCTAssertFalse(PathGuard.hasMdExt("a.txt"))
        XCTAssertFalse(PathGuard.hasMdExt(nil))
        XCTAssertEqual(try PathGuard.assertMd("作品/a.md"), "a.md")
        assertBad(try PathGuard.assertMd("作品/a.txt"), "只允许 .md")
        XCTAssertEqual(PathGuard.ensureMd("a"), "a.md")
        XCTAssertEqual(PathGuard.ensureMd("a.MD"), "a.MD")
        XCTAssertEqual(PathGuard.ensureMd(nil), ".md")
    }

    func testTrashStamp() {
        XCTAssertEqual(
            PathGuard.trashStamp(year: 2026, month: 3, day: 5, hour: 9, minute: 7, second: 1),
            "20260305-090701")
        XCTAssertNotNil(PathGuard.trashStampNow().range(of: #"^\d{8}-\d{6}$"#,
                                                        options: .regularExpression))
        XCTAssertEqual(PathGuard.stripTrashStamp("日记-20260305-090701"), "日记")
        XCTAssertEqual(PathGuard.stripTrashStamp("日记"), "日记")
    }

    func testQuote() {
        XCTAssertEqual(PathGuard.quote("a"), "\"a\"")
        XCTAssertEqual(PathGuard.quote("a\"b"), "\"a\\\"b\"")
        XCTAssertEqual(PathGuard.quote("a\\b"), "\"a\\\\b\"")
    }

    func testResolveInRootAcceptsAndBlocksEscape() throws {
        let root = try makeTempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let resolved = try PathGuard.resolveInRoot(root: root, relPath: "作品/a.md")
        XCTAssertEqual(resolved.path,
                       root.appendingPathComponent("作品").appendingPathComponent("a.md").path)

        assertBad(try PathGuard.resolveInRoot(root: root, relPath: "../escape.md"),
                  "路径段不得为")

        let outside = root.deletingLastPathComponent()
            .appendingPathComponent("PathGuardOutside-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outside) }

        let link = root.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)
        assertBad(try PathGuard.resolveInRoot(root: root, relPath: "link/x.md"), "路径越界")

        assertBad(try PathGuard.resolveInRoot(root: root, relPath: "."), "路径为空")
    }

    func testUniquePath() throws {
        let root = try makeTempRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let f = root.appendingPathComponent("a.md")
        XCTAssertEqual(try PathGuard.uniquePath(f, isDir: false).lastPathComponent, "a.md")

        FileManager.default.createFile(atPath: f.path, contents: Data())
        XCTAssertEqual(try PathGuard.uniquePath(f, isDir: false).lastPathComponent, "a-2.md")

        FileManager.default.createFile(
            atPath: root.appendingPathComponent("a-2.md").path, contents: Data())
        XCTAssertEqual(try PathGuard.uniquePath(f, isDir: false).lastPathComponent, "a-3.md")

        let dotless = root.appendingPathComponent("README")
        FileManager.default.createFile(atPath: dotless.path, contents: Data())
        XCTAssertEqual(try PathGuard.uniquePath(dotless, isDir: false).lastPathComponent,
                       "README-2")

        let d = root.appendingPathComponent("作品")
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        XCTAssertEqual(try PathGuard.uniquePath(d, isDir: true).lastPathComponent, "作品-2")
    }
}
