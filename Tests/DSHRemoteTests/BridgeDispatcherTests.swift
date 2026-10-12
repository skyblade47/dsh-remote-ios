import XCTest
@testable import DSHRemote

final class BridgeDispatcherTests: XCTestCase {

    var root: URL!
    var dispatcher: BridgeDispatcher!
    var container: URL!
    var multi: BridgeDispatcher!
    var pomoFile: URL { root.appendingPathComponent("番茄钟记录.md") }

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("BridgeTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        dispatcher = try BridgeDispatcher(dataDir: root.appendingPathComponent("data"),
                                          workspaceRoot: root,
                                          appVersion: "0.1.0-test",
                                          now: { Date(timeIntervalSince1970: 1_790_000_000) })
        container = root.appendingPathComponent("wsbox", isDirectory: true)
        multi = try BridgeDispatcher(dataDir: root.appendingPathComponent("mdata"),
                                     workspaceRoot: container,
                                     multiWorkspace: true,
                                     appVersion: "0.1.0-test",
                                     now: { Date(timeIntervalSince1970: 1_790_000_000) })
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    func call(_ method: String, _ args: [Any] = []) -> [String: Any] {
        dispatcher.dispatch(method, args: args)
    }

    func callJson(_ method: String, _ argsJson: String) -> [String: Any] {
        dispatcher.dispatch(method, argsJson: argsJson)
    }

    // MARK: - getState

    func testGetStateOverridesSandboxAndPlatform() {
        let s = call("getState")
        XCTAssertEqual(s["ok"] as? Bool, true)
        XCTAssertEqual(s["platform"] as? String, "ipad")
        XCTAssertEqual(s["root"] as? String, root.path)
        XCTAssertEqual(s["rootExists"] as? Bool, true)
        XCTAssertEqual(s["appVersion"] as? String, "0.1.0-test")
        XCTAssertEqual(s["settings"] == nil, false)
    }

    // MARK: - 工作区写入 + outbox 自动入队

    func testWriteDocEnqueuesOutbox() {
        let r = call("writeDoc", ["作品A/第一章.md", "正文"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        let box = call("outboxList")
        let items = box["entries"] as? [[String: Any]]
        XCTAssertEqual(items?.count, 1)
        XCTAssertEqual(items?[0]["relPath"] as? String, "作品A/第一章.md")
    }

    func testWriteDocSyncAlsoEnqueues() {
        XCTAssertEqual(call("writeDocSync", ["a.md", "x"])["ok"] as? Bool, true)
        XCTAssertEqual(call("outboxList")["entries"] == nil, false)
        XCTAssertEqual((call("outboxList")["entries"] as? [[String: Any]])?.count, 1)
    }

    func testWriteDocFailureDoesNotEnqueue() {
        let r = call("writeDoc", ["/绝对.md", "x"])
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertEqual((call("outboxList")["entries"] as? [[String: Any]])?.count, 0)
    }

    func testOutboxRemove() {
        call("writeDoc", ["a.md", "x"])
        XCTAssertEqual(call("outboxRemove", ["a.md"])["ok"] as? Bool, true)
        XCTAssertEqual((call("outboxList")["entries"] as? [[String: Any]])?.count, 0)
    }

    // MARK: - 工作区只读方法透传

    func testWorkspaceRoundTripThroughDispatcher() {
        XCTAssertEqual(call("createWork", ["作品B"])["ok"] as? Bool, true)
        XCTAssertEqual(call("createDoc", ["作品B", "第二章"])["ok"] as? Bool, true)
        let ws = call("listWorkspace")
        XCTAssertEqual(ws["ok"] as? Bool, true)
        let read = call("readDoc", ["作品B/第二章.md"])
        XCTAssertEqual(read["ok"] as? Bool, true)
    }

    // MARK: - 草稿经沙盒 root

    func testDraftUsesSandboxRootAndRoundTrips() {
        let w = call("writeDraft", ["作品A/x.md", "草稿内容"])
        XCTAssertEqual(w["ok"] as? Bool, true)
        let r = call("readDraft", ["作品A/x.md"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertTrue((r["content"] as? String ?? "").contains("草稿内容"))
        XCTAssertEqual(call("clearDraft", ["作品A/x.md"])["ok"] as? Bool, true)
    }

    func testDraftsUsageAndPending() {
        XCTAssertEqual(call("draftsUsage")["ok"] as? Bool, true)
        XCTAssertEqual(call("listPendingDrafts")["ok"] as? Bool, true)
    }

    // MARK: - 配置 / 会话 / 校对 / 基线

    func testSaveConfigAndProofAndBaseline() {
        XCTAssertEqual(call("saveConfig", [["pomodoro": ["focusMin": 500]]])["ok"] as? Bool,
                       true)
        XCTAssertEqual((call("getState")["pomodoro"] as? [String: Any])?["focusMin"] as? Int64,
                       180)
        XCTAssertEqual(call("proofSave", [["relPath": "a.md", "items": []]])["ok"] as? Bool,
                       true)
        XCTAssertEqual(call("proofLoad", ["a.md"])["ok"] as? Bool, true)
        XCTAssertEqual(call("getLastSession")["ok"] as? Bool, true)
        XCTAssertEqual(call("syncBaseline")["ok"] as? Bool, true)
        XCTAssertEqual(call("syncBaselineSet", [["version": 1, "items": [:]]])["ok"] as? Bool,
                       true)
    }

    // MARK: - hash12

    func testHash12Bridge() {
        let r = call("hash12", ["abc"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["hash"] as? String, "a9993e364706")
        let empty = call("hash12", [])
        XCTAssertEqual(empty["hash"] as? String, "da39a3ee5e6b")
    }

    // MARK: - appendPomodoro

    func testAppendPomodoroWritesFirstLine() throws {
        let r = call("appendPomodoro", [["focusMin": 25, "doc": "第一章"]])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["line"] as? Int64, 1)
        XCTAssertEqual(r["file"] as? String, pomoFile.path)
        let text = try String(contentsOf: pomoFile, encoding: .utf8)
        XCTAssertTrue(text.hasPrefix("1. "))
        XCTAssertTrue(text.contains("· 专注 25 分钟 · 第一章"))
        XCTAssertTrue(text.hasSuffix("\n"))
    }

    func testAppendPomodoroDefaultsFocusAndNoDoc() throws {
        call("appendPomodoro", [[:]])
        let text = try String(contentsOf: pomoFile, encoding: .utf8)
        XCTAssertTrue(text.contains("· 专注 25 分钟"))
        XCTAssertFalse(text.contains("· 专注 25 分钟 ·"))
    }

    func testAppendPomodoroIncrementsLines() {
        call("appendPomodoro", [[:]])
        let r2 = call("appendPomodoro", [[:]])
        XCTAssertEqual(r2["line"] as? Int64, 2)
    }

    func testAppendPomodoroRejectsNonMapPayload() {
        let r = call("appendPomodoro", [42])
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertTrue((r["error"] as? String ?? "").contains("payload 必须是对象"))
    }

    // MARK: - 生命周期 no-op 与 iOS 裁剪方法

    func testLifecycleCallbacksAreOkNoOps() {
        for m in ["reportDirty", "onFlushRequest", "flushDone", "relaunch",
                  "scheduleReminder", "cancelReminder", "getDeviceId",
                  "notifyWriting", "nativeOnline"] {
            let r = call(m)
            XCTAssertEqual(r["ok"] as? Bool, true, "方法 \(m) 应为宽容 no-op")
            XCTAssertNil(r["error"])
        }
    }

    // MARK: - 不支持的目录/导入方法（由 ipad.js 适配层覆盖，原生不做系统选择器）

    func testPickAndImportAreNotSupported() {
        for m in ["pickRoot", "pickDir", "pickImportFiles", "pickImportDir",
                  "importInto", "onImportProgress"] {
            let r = call(m)
            XCTAssertEqual(r["ok"] as? Bool, false, "方法 \(m) 原生应保持 NotSupported")
            XCTAssertTrue((r["error"] as? String ?? "").hasPrefix("NotSupported:"))
        }
    }

    // MARK: - 沙盒内多工作区

    func mcall(_ method: String, _ args: [Any] = []) -> [String: Any] {
        multi.dispatch(method, args: args)
    }

    func testMultiWorkspaceStartsWithoutCurrentRoot() {
        let s = mcall("getState")
        XCTAssertEqual(s["ok"] as? Bool, true)
        XCTAssertTrue(s["root"] is NSNull, "首启未选/建工作区时 root 应为 null")
        XCTAssertEqual(s["rootExists"] as? Bool, false)
        let r = mcall("listRoots")
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["container"] as? String, container.path)
        XCTAssertEqual((r["roots"] as? [[String: Any]])?.count, 0)
    }

    func testCreateRootMakesChildUnderContainer() {
        let r = mcall("createRoot", ["小说集", nil])
        XCTAssertEqual(r["ok"] as? Bool, true)
        let child = container.appendingPathComponent("小说集", isDirectory: true)
        XCTAssertEqual(r["root"] as? String, child.path)
        XCTAssertNotNil(r["parentSource"] as? String)
        var isDir: ObjCBool = false
        XCTAssertTrue(FileManager.default.fileExists(atPath: child.path, isDirectory: &isDir))
        XCTAssertTrue(isDir.boolValue)
        // 创建后即成为当前根
        XCTAssertEqual(mcall("getState")["root"] as? String, child.path)
        // 容器枚举可见
        let list = mcall("listRoots")
        let names = (list["roots"] as? [[String: Any]])?.compactMap { $0["name"] as? String }
        XCTAssertEqual(names, ["小说集"])
    }

    func testCreateRootRejectsDuplicateAndBadName() {
        XCTAssertEqual(mcall("createRoot", ["小说集", nil])["ok"] as? Bool, true)
        let dup = mcall("createRoot", ["小说集", nil])
        XCTAssertEqual(dup["ok"] as? Bool, false)
        XCTAssertTrue((dup["error"] as? String ?? "").contains("已存在"))
        let bad = mcall("createRoot", ["a/b", nil])
        XCTAssertEqual(bad["ok"] as? Bool, false)
        XCTAssertFalse((bad["error"] as? String ?? "").isEmpty)
        // 失败不改变当前根
        XCTAssertEqual(mcall("getState")["root"] as? String,
                       container.appendingPathComponent("小说集").path)
    }

    func testCreateRootIgnoresParentDirInsideSandbox() {
        // iPad 沙盒不接受外部父目录；parentDir 仅作为自由描述，根始终落在容器内
        let r = mcall("createRoot", ["随笔", "/some/host/path"])
        XCTAssertEqual(r["ok"] as? Bool, true)
        XCTAssertEqual(r["root"] as? String,
                       container.appendingPathComponent("随笔").path)
    }

    func testSwitchRootMovesAllIoToNewRoot() throws {
        XCTAssertEqual(mcall("createRoot", ["甲", nil])["ok"] as? Bool, true)
        XCTAssertEqual(mcall("writeDoc", ["作品/甲.md", "甲正文"])["ok"] as? Bool, true)
        XCTAssertEqual(mcall("writeDraft", ["作品/甲.md", "甲草稿"])["ok"] as? Bool, true)
        mcall("appendPomodoro", [[:]])

        XCTAssertEqual(mcall("createRoot", ["乙", nil])["ok"] as? Bool, true)
        // 新根下看不到旧根的作品
        let ws = mcall("listWorkspace")
        XCTAssertEqual((ws["works"] as? [[String: Any]])?.count, 0)
        // 文档落在乙根
        XCTAssertEqual(mcall("writeDoc", ["作品/乙.md", "乙正文"])["ok"] as? Bool, true)
        let read = mcall("readDoc", ["作品/乙.md"])
        XCTAssertEqual(read["ok"] as? Bool, true)
        XCTAssertEqual(read["content"] as? String, "乙正文")
        // 草稿按根隔离：乙根下读不到甲根的草稿
        let draft = mcall("readDraft", ["作品/甲.md"])
        XCTAssertEqual(draft["ok"] as? Bool, false)
        // 番茄钟记录落在乙根
        let pomoB = container.appendingPathComponent("乙").appendingPathComponent("番茄钟记录.md")
        XCTAssertTrue(FileManager.default.fileExists(atPath: pomoB.path))
        let pomoA = container.appendingPathComponent("甲").appendingPathComponent("番茄钟记录.md")
        XCTAssertTrue(FileManager.default.fileExists(atPath: pomoA.path))

        // 切回甲：作品与草稿都还在
        let sw = mcall("switchRoot", ["甲"])
        XCTAssertEqual(sw["ok"] as? Bool, true)
        XCTAssertEqual(sw["root"] as? String,
                       container.appendingPathComponent("甲").path)
        let wsA = mcall("listWorkspace")
        let namesA = (wsA["works"] as? [[String: Any]])?.compactMap { $0["name"] as? String }
        XCTAssertEqual(namesA, ["作品"])
        let draftA = mcall("readDraft", ["作品/甲.md"])
        XCTAssertEqual(draftA["ok"] as? Bool, true)
        XCTAssertTrue((draftA["content"] as? String ?? "").contains("甲草稿"))
    }

    func testSwitchRootRejectsUnknownAndStays() {
        XCTAssertEqual(mcall("createRoot", ["甲", nil])["ok"] as? Bool, true)
        let r = mcall("switchRoot", ["不存在"])
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertEqual(mcall("getState")["root"] as? String,
                       container.appendingPathComponent("甲").path)
    }

    func testCurrentRootPersistsAcrossDispatcherRebuild() throws {
        XCTAssertEqual(mcall("createRoot", ["长期", nil])["ok"] as? Bool, true)
        XCTAssertEqual(mcall("writeDoc", ["作品/x.md", "内容"])["ok"] as? Bool,
                       true)
        let rebuilt = try BridgeDispatcher(dataDir: root.appendingPathComponent("mdata"),
                                           workspaceRoot: container,
                                           multiWorkspace: true,
                                           appVersion: "0.1.0-test")
        let s = rebuilt.dispatch("getState", args: [])
        XCTAssertEqual(s["root"] as? String,
                       container.appendingPathComponent("长期").path)
        let ws = rebuilt.dispatch("listWorkspace", args: [])
        XCTAssertEqual((ws["works"] as? [[String: Any]])?.count, 1)
        let read = rebuilt.dispatch("readDoc", args: ["作品/x.md"])
        XCTAssertEqual(read["content"] as? String, "内容")
    }

    func testSingleRootModeRejectsMultiRootApis() {
        // 单根模式（旧测试构造）不暴露多工作区 API
        XCTAssertEqual(call("createRoot", ["x", nil])["ok"] as? Bool, false)
        XCTAssertEqual(call("switchRoot", ["x"])["ok"] as? Bool, false)
        XCTAssertEqual(call("listRoots")["ok"] as? Bool, false)
    }

    // MARK: - 未知方法 / 空方法名 / JSON 入参

    func testUnknownMethodFails() {
        let r = call("noSuchMethod")
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertEqual(r["error"] as? String, "未知方法: noSuchMethod")
    }

    func testEmptyMethodNameFails() {
        XCTAssertEqual(call("")["error"] as? String, "未知方法: ")
    }

    func testArgsJsonArrayParsed() {
        let r = callJson("writeDoc", "[\"j.md\",\"通过 JSON\"]")
        XCTAssertEqual(r["ok"] as? Bool, true)
    }

    func testArgsJsonNonArrayFailsWithPrefix() {
        let r = callJson("getState", "{\"a\":1}")
        XCTAssertTrue((r["error"] as? String ?? "").hasPrefix("参数必须是 JSON 数组"))
    }

    func testArgsJsonCorruptFailsWithPrefix() {
        let r = callJson("getState", "[1,2")
        XCTAssertTrue((r["error"] as? String ?? "").hasPrefix("参数必须是 JSON 数组"))
    }

    func testArgsJsonNullBecomesEmptyArgs() {
        XCTAssertEqual(callJson("getState", "null")["ok"] as? Bool, true)
    }

    // MARK: - 底层 throws 不外泄

    func testThrowingStoreMethodBecomesFailMap() {
        let r = call("readDoc", ["../逃逸.md"])
        XCTAssertEqual(r["ok"] as? Bool, false)
        XCTAssertFalse((r["error"] as? String ?? "").isEmpty)
    }
}
