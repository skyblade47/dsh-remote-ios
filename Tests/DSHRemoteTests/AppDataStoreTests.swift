import XCTest
@testable import DSHRemote

final class AppDataStoreTests: XCTestCase {

    var dir: URL!
    var data: AppDataStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("AppDataTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        data = AppDataStore(dataDir: dir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
        data = nil
        dir = nil
        try super.tearDownWithError()
    }

    // MARK: - 读取工具

    func dict(_ r: [String: Any], _ key: String) -> [String: Any] {
        (r[key] as? [String: Any]) ?? [:]
    }

    func arr(_ r: [String: Any], _ key: String) -> [Any] {
        if let strs = r[key] as? [String] { return strs }
        return (r[key] as? [Any]) ?? []
    }

    @discardableResult
    func save(_ patch: [String: Any]) -> [String: Any] {
        let r = data.saveConfig(patch)
        XCTAssertTrue((r["ok"] as? Bool) == true, "saveConfig 失败：\(r["error"] ?? "")")
        return r
    }

    func writeRawConfig(_ text: String) {
        let f = dir.appendingPathComponent("config.json")
        try? text.data(using: .utf8)!.write(to: f)
    }

    // MARK: - getState 默认值（iOS 个人常量缺省为空串）

    func testGetStateDefaults() {
        let s = data.getState()
        XCTAssertTrue((s["ok"] as? Bool) == true)
        XCTAssertTrue(s["root"] is NSNull)
        XCTAssertFalse((s["rootExists"] as? Bool) == true)
        XCTAssertEqual(s["draftsDir"] as? String, dir.appendingPathComponent("drafts").path)

        let pomo = dict(s, "pomodoro")
        XCTAssertEqual(pomo["focusMin"] as? Int64, 25)
        XCTAssertEqual(pomo["breakMin"] as? Int64, 5)
        XCTAssertEqual(pomo["autoNext"] as? Bool, true)

        let settings = dict(s, "settings")
        XCTAssertEqual(dict(settings, "autosave")["debounceMs"] as? Int64, 1000)
        let d = dict(settings, "drafts")
        XCTAssertEqual(d["maxFiles"] as? Int64, 200)
        XCTAssertEqual(d["maxBytes"] as? Int64, 5 * 1024 * 1024)
        XCTAssertEqual(d["maxTotalBytes"] as? Int64, 128 * 1024 * 1024)
        XCTAssertEqual(d["notifyOnStartup"] as? Bool, true)
        XCTAssertEqual(settings["theme"] as? String, "auto")
        XCTAssertEqual(dict(settings, "general")["autoStart"] as? Bool, false)
        XCTAssertEqual(dict(settings, "general")["tray"] as? Bool, true)
        XCTAssertEqual(arr(dict(settings, "send"), "intents") as? [String],
                       ["错字/病句检查", "结构诊断", "续写"])
        let remote = dict(settings, "remote")
        XCTAssertEqual(remote["mode"] as? String, "auto")
        XCTAssertEqual(remote["gateway"] as? String, "")
        XCTAssertEqual(remote["port"] as? Int64, 18080)

        XCTAssertEqual(dict(s, "proofread")["sessionId"] as? String, "")
        let wp = dict(s, "writingPrefs")
        XCTAssertEqual(wp["dailyGoal"] as? Int64, 1000)
        XCTAssertEqual(wp["reminderEnabled"] as? Bool, true)
        XCTAssertEqual(wp["reminderTime"] as? String, "20:00")
    }

    func testGetStateWithWorkspaceRoot() {
        writeRawConfig("{\"workspaceRoot\":" + jsonString(dir.path) + "}")
        let s = data.getState()
        XCTAssertEqual(s["root"] as? String, dir.path)
        XCTAssertEqual(s["rootExists"] as? Bool, true)
    }

    func jsonString(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s], options: [])
        let arr = String(decoding: data, as: UTF8.self)
        return String(arr.dropFirst().dropLast())
    }

    // MARK: - saveConfig：未知键/番茄钟/草稿/autosave/theme/general

    func testSaveConfigIgnoresUnknownKeys() {
        let r = data.saveConfig(["unknownTopLevel": ["nested": 1]])
        XCTAssertTrue((r["ok"] as? Bool) == true)
        let raw = (try? String(contentsOf: dir.appendingPathComponent("config.json"),
                               encoding: .utf8)) ?? ""
        XCTAssertFalse(raw.contains("unknownTopLevel"), "未知顶层键必须丢弃，不落盘")
    }

    func testSavePomodoroClamps() {
        save(["pomodoro": ["focusMin": 0, "breakMin": 999, "autoNext": false, "junk": 1]])
        let pomo = dict(data.getState(), "pomodoro")
        XCTAssertEqual(pomo["focusMin"] as? Int64, 1)
        XCTAssertEqual(pomo["breakMin"] as? Int64, 60)
        XCTAssertEqual(pomo["autoNext"] as? Bool, false)
        save(["pomodoro": ["focusMin": 999, "breakMin": -3]])
        let p2 = dict(data.getState(), "pomodoro")
        XCTAssertEqual(p2["focusMin"] as? Int64, 180)
        XCTAssertEqual(p2["breakMin"] as? Int64, 1)
        XCTAssertEqual(p2["autoNext"] as? Bool, false, "未提供的键沿用上次合并值")
    }

    func testSaveDraftsClampsAndNotifyDefault() {
        save(["drafts": ["maxFiles": 0, "maxBytes": 10, "maxTotalBytes": 10,
                         "notifyOnStartup": false]])
        let d = dict(dict(data.getState(), "settings"), "drafts")
        XCTAssertEqual(d["maxFiles"] as? Int64, 1)
        XCTAssertEqual(d["maxBytes"] as? Int64, 1024)
        XCTAssertEqual(d["maxTotalBytes"] as? Int64, 1024 * 1024)
        XCTAssertEqual(d["notifyOnStartup"] as? Bool, false)

        save(["drafts": ["maxFiles": 99999, "maxTotalBytes": "x"]])
        let d2 = dict(dict(data.getState(), "settings"), "drafts")
        XCTAssertEqual(d2["maxFiles"] as? Int64, 10000)
        XCTAssertEqual(d2["maxTotalBytes"] as? Int64, 1024 * 1024,
                       "非法值回落为该字段缺省，而非旧值")
        XCTAssertEqual(d2["notifyOnStartup"] as? Bool, false, "未提供则沿用旧值")
    }

    func testSaveAutosaveThemeGeneral() {
        save(["autosave": ["debounceMs": 50],
              "theme": "dark",
              "general": ["autoStart": true, "tray": false]])
        let settings = dict(data.getState(), "settings")
        XCTAssertEqual(dict(settings, "autosave")["debounceMs"] as? Int64, 200)
        XCTAssertEqual(settings["theme"] as? String, "dark")
        XCTAssertEqual(dict(settings, "general")["autoStart"] as? Bool, true)
        XCTAssertEqual(dict(settings, "general")["tray"] as? Bool, false)

        save(["autosave": ["debounceMs": 20000], "theme": "neon", "general": [:]])
        let s2 = dict(data.getState(), "settings")
        XCTAssertEqual(dict(s2, "autosave")["debounceMs"] as? Int64, 10000)
        XCTAssertEqual(s2["theme"] as? String, "auto")
        XCTAssertEqual(dict(s2, "general")["autoStart"] as? Bool, false)
        XCTAssertEqual(dict(s2, "general")["tray"] as? Bool, true)
    }

    // MARK: - saveConfig：remote（gateway 失败立即返回且不写盘）

    func testSaveRemoteModePort() {
        save(["remote": ["mode": "manual", "port": 80]])
        let r = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(r["mode"] as? String, "manual")
        XCTAssertEqual(r["port"] as? Int64, 1024)
        save(["remote": ["mode": "weird", "port": 70000]])
        let r2 = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(r2["mode"] as? String, "auto")
        XCTAssertEqual(r2["port"] as? Int64, 65535)
    }

    func testSaveGatewayValidTrimsAndPersists() {
        let r = save(["remote": ["gateway": "  https://example.com:9000/x  "]])
        let remote = dict(r, "settings")
        _ = remote
        let onDisk = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(onDisk["gateway"] as? String, "https://example.com:9000/x")
    }

    func testSaveGatewayInvalidFailsAndDoesNotWrite() {
        save(["theme": "dark"])
        let before = (try? String(contentsOf: dir.appendingPathComponent("config.json"),
                                  encoding: .utf8)) ?? ""
        let r = data.saveConfig(["remote": ["gateway": "ftp://nope"]])
        XCTAssertFalse((r["ok"] as? Bool) == true)
        XCTAssertTrue((r["error"] as? String ?? "").contains("gateway"))
        let after = (try? String(contentsOf: dir.appendingPathComponent("config.json"),
                                 encoding: .utf8)) ?? ""
        XCTAssertEqual(before, after, "gateway 非法时不得写盘")
        XCTAssertEqual(dict(dict(data.getState(), "settings"), "remote")["gateway"] as? String, "")
    }

    func testSettingsGatewayFallsBackToEmptyWhenConfigMalformed() {
        writeRawConfig("{\"remote\":{\"gateway\":\"not-a-url\"}}")
        XCTAssertEqual(dict(dict(data.getState(), "settings"), "remote")["gateway"] as? String, "")
    }

    // MARK: - saveConfig：网关保存钩子（壳以新 origin 重建的触发点）

    func testSaveGatewayFiresHookWithTrimmedValue() {
        var got: [String] = []
        AppDataStore.onGatewaySaved = { got.append($0) }
        defer { AppDataStore.onGatewaySaved = nil }
        save(["remote": ["gateway": "  https://example.com:9000/x  "]])
        XCTAssertEqual(got, ["https://example.com:9000/x"])
    }

    func testSaveGatewayInvalidDoesNotFireHook() {
        var got: [String] = []
        AppDataStore.onGatewaySaved = { got.append($0) }
        defer { AppDataStore.onGatewaySaved = nil }
        let r = data.saveConfig(["remote": ["gateway": "ftp://nope"]])
        XCTAssertFalse((r["ok"] as? Bool) == true)
        XCTAssertTrue(got.isEmpty)
    }

    func testSaveNonGatewayDoesNotFireHook() {
        var called = false
        AppDataStore.onGatewaySaved = { _ in called = true }
        defer { AppDataStore.onGatewaySaved = nil }
        save(["theme": "dark"])
        XCTAssertFalse(called)
    }

    // MARK: - 首启迁移 seedGatewayIfEmpty（原生条 → config.json 回填）

    func testSeedGatewayFillsEmptyConfig() {
        data.seedGatewayIfEmpty(" https://example.com:9000/x/ ")
        let remote = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(remote["gateway"] as? String, "https://example.com:9000/x")
    }

    func testSeedGatewayKeepsExistingConfig() {
        save(["remote": ["gateway": "https://keep.example"]])
        data.seedGatewayIfEmpty("https://other.example")
        let remote = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(remote["gateway"] as? String, "https://keep.example")
    }

    func testSeedGatewayIgnoresUnnormalizable() {
        data.seedGatewayIfEmpty("http://plain.example") // GatewayURL 只收 https
        data.seedGatewayIfEmpty("")
        data.seedGatewayIfEmpty("not-a-url")
        let remote = dict(dict(data.getState(), "settings"), "remote")
        XCTAssertEqual(remote["gateway"] as? String, "")
    }

    // MARK: - saveConfig：proofread / writingPrefs / ui / intents / editor / preview

    func testSaveProofreadSessionValidation() {
        save(["proofread": ["sessionId": "session-abc123"]])
        XCTAssertEqual(dict(data.getState(), "proofread")["sessionId"] as? String,
                       "session-abc123")
        save(["proofread": ["sessionId": "nope"]])
        XCTAssertEqual(dict(data.getState(), "proofread")["sessionId"] as? String, "")
    }

    func testSaveWritingPrefs() {
        save(["writingPrefs": ["dailyGoal": 200000, "reminderEnabled": false,
                               "reminderTime": "09:05"]])
        let wp = dict(data.getState(), "writingPrefs")
        XCTAssertEqual(wp["dailyGoal"] as? Int64, 100000)
        XCTAssertEqual(wp["reminderEnabled"] as? Bool, false)
        XCTAssertEqual(wp["reminderTime"] as? String, "09:05")

        save(["writingPrefs": ["dailyGoal": -5, "reminderTime": "99:99"]])
        let wp2 = dict(data.getState(), "writingPrefs")
        XCTAssertEqual(wp2["dailyGoal"] as? Int64, 0)
        XCTAssertEqual(wp2["reminderTime"] as? String, "09:05", "非法时间不覆盖旧值")
        XCTAssertEqual(wp2["reminderEnabled"] as? Bool, false, "未提供沿用旧值")
    }

    func testSaveUISplitDeepMerge() {
        save(["ui": ["split": ["ratio": 0.25, "on": true], "custom": 7]])
        save(["ui": ["split": ["ratio": 0.95]]])
        let ui = dict(data.getState(), "ui")
        let split = dict(ui, "split")
        XCTAssertEqual(split["ratio"] as? Double, 0.8)
        XCTAssertEqual(split["on"] as? Bool, true, "split 深合并保留 on")
        XCTAssertEqual(ui["custom"] as? Int64, 7, "ui 其余自定义键原样保留")
    }

    func testSaveIntentsNormalizeDedupeCap() {
        let r = save(["send": ["intents": [" A ", "A", "多\n行", "a\r\n\r\nb", String(repeating: "x", count: 50)]]])
        let intents = arr(dict(dict(r, "settings"), "send"), "intents") as? [String] ?? []
        XCTAssertEqual(intents[0], "A")
        XCTAssertEqual(intents[1], "多 行")
        // Java replaceAll("[\\r\\n]+", " ")：连续换行只折叠成一个空格
        XCTAssertEqual(intents[2], "a b")
        XCTAssertEqual(intents[3].count, 40)
        XCTAssertEqual(intents.count, 4)

        let many = (0..<30).map { "意图\($0)" }
        let r2 = save(["send": ["intents": many]])
        XCTAssertEqual((arr(dict(dict(r2, "settings"), "send"), "intents") as? [String])?.count, 20)
    }

    func testSaveEditorNormalization() {
        save(["editor": ["fontSize": 40, "fontFamily": "bogus", "lineHeight": 3,
                         "letterSpacing": 1, "measure": 9, "colorPreset": "sepia",
                         "extra": "keep"]])
        let e = dict(dict(data.getState(), "settings"), "editor")
        XCTAssertEqual(e["fontSize"] as? Int64, 32)
        XCTAssertEqual(e["fontFamily"] as? String, "kai")
        XCTAssertEqual(e["lineHeight"] as? Double, 2.4)
        XCTAssertEqual(e["letterSpacing"] as? Double, 0.1)
        XCTAssertEqual(e["measure"] as? Int64, 20)
        XCTAssertEqual(e["colorPreset"] as? String, "sepia")
        XCTAssertEqual(e["extra"] as? String, "keep")

        save(["editor": ["fontSize": 15.4]])
        XCTAssertEqual(dict(dict(data.getState(), "settings"), "editor")["fontSize"] as? Int64, 15)
        save(["editor": [:]])
        XCTAssertEqual(dict(dict(data.getState(), "settings"), "editor")["fontSize"] as? Int64, 0,
                       "非法/非正 fontSize 归一为 0")
    }

    func testSavePreviewNormalization() {
        save(["preview": ["fontSize": 12, "lineHeight": 1.8, "fontFamily": "serif",
                          "paraSpacing": 3, "indent": 9]])
        let p = dict(dict(data.getState(), "settings"), "preview")
        XCTAssertEqual(p["fontSize"] as? Int64, 12)
        XCTAssertEqual(p["lineHeight"] as? Double, 1.8)
        XCTAssertEqual(p["fontFamily"] as? String, "serif")
        XCTAssertEqual(p["paraSpacing"] as? Double, 2)
        XCTAssertEqual(p["indent"] as? Int64, 2)

        save(["preview": ["paraSpacing": "auto", "fontFamily": "nope"]])
        let p2 = dict(dict(data.getState(), "settings"), "preview")
        XCTAssertEqual(p2["paraSpacing"] as? String, "auto")
        XCTAssertEqual(p2["fontFamily"] as? String, "auto")
    }

    func testCorruptConfigFallsBackToEmpty() {
        writeRawConfig("{not json")
        let s = data.getState()
        XCTAssertTrue((s["ok"] as? Bool) == true)
        XCTAssertEqual(dict(s, "pomodoro")["focusMin"] as? Int64, 25)
    }

    // MARK: - 草稿

    func testWriteReadClearDraft() {
        let w = data.writeDraft(root: dir.path, relPath: "作品A/文档一.md", content: "正文")
        XCTAssertTrue((w["ok"] as? Bool) == true)
        XCTAssertEqual(w["bytes"] as? Int64, 6)
        let key = w["key"] as? String
        XCTAssertEqual(key?.count, 24)

        let r = data.readDraft(root: dir.path, relPath: "作品A/文档一.md")
        XCTAssertEqual(r["content"] as? String, "正文")

        let cleared = data.clearDraft(root: dir.path, relPath: "作品A/文档一.md")
        XCTAssertEqual(cleared["cleared"] as? Int64, 2)
        let again = data.clearDraft(root: dir.path, relPath: "作品A/文档一.md")
        XCTAssertEqual(again["cleared"] as? Int64, 0)
    }

    func testWriteDraftRejectsOversize() {
        save(["drafts": ["maxBytes": 1024]])
        let big = String(repeating: "字", count: 2000)
        let r = data.writeDraft(root: dir.path, relPath: "w/big.md", content: big)
        XCTAssertFalse((r["ok"] as? Bool) == true)
        XCTAssertTrue((r["error"] as? String ?? "").contains("草稿过大"))
    }

    func testDraftsUsageCountsOnlyMd() throws {
        _ = data.writeDraft(root: dir.path, relPath: "a/x.md", content: "1234")
        let draftsDir = dir.appendingPathComponent("drafts")
        try "junk".data(using: .utf8)!.write(to: draftsDir.appendingPathComponent("note.txt"))
        let u = data.draftsUsage()
        XCTAssertEqual(u["files"] as? Int64, 1)
        XCTAssertEqual(u["bytes"] as? Int64, 4)
        XCTAssertEqual(u["limitFiles"] as? Int64, 200)
        XCTAssertEqual(u["limitBytes"] as? Int64, 128 * 1024 * 1024)
        XCTAssertEqual(u["dir"] as? String, draftsDir.path)
    }

    func testListPendingDraftsExpiresAgainstFormal() throws {
        _ = data.writeDraft(root: dir.path, relPath: "作品A/新.md", content: "草稿内容")
        let pending1 = data.listPendingDrafts(root: dir.path)
        XCTAssertEqual((arr(pending1, "drafts") as? [[String: Any]])?.count, 1)
        let entry = (arr(pending1, "drafts") as? [[String: Any]])?[0]
        XCTAssertEqual(entry?["relPath"] as? String, "作品A/新.md")
        XCTAssertEqual(entry?["work"] as? String, "作品A")
        XCTAssertEqual(entry?["name"] as? String, "新.md")
        XCTAssertEqual(entry?["formalExists"] as? Bool, false)

        let formal = dir.appendingPathComponent("作品A/新.md")
        try FileManager.default.createDirectory(at: formal.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try "更新的正式".data(using: .utf8)!.write(to: formal)
        Thread.sleep(forTimeInterval: 0.02)
        let formalMtime = Int64((try FileManager.default.attributesOfItem(atPath: formal.path)[
            .modificationDate] as! Date).timeIntervalSince1970 * 1000)

        let pending2 = data.listPendingDrafts(root: dir.path)
        XCTAssertEqual((arr(pending2, "drafts") as? [[String: Any]])?.count, 0,
                       "正式文档不旧时草稿应过期清除")
        _ = formalMtime
    }

    func testPruneDraftsByMaxFiles() {
        save(["drafts": ["maxFiles": 2, "maxTotalBytes": 4 * 1024 * 1024 * 1024]])
        _ = data.writeDraft(root: dir.path, relPath: "w/a.md", content: "aaaa")
        Thread.sleep(forTimeInterval: 0.01)
        _ = data.writeDraft(root: dir.path, relPath: "w/b.md", content: "bbbb")
        Thread.sleep(forTimeInterval: 0.01)
        _ = data.writeDraft(root: dir.path, relPath: "w/c.md", content: "cccc")
        let u = data.draftsUsage()
        XCTAssertEqual(u["files"] as? Int64, 2, "最旧一条应被剪枝")
        let pending = (arr(data.listPendingDrafts(root: dir.path), "drafts")
                       as? [[String: Any]])?.map { $0["relPath"] as? String } ?? []
        XCTAssertFalse(pending.contains("w/a.md"))
        XCTAssertTrue(pending.contains("w/c.md"))
    }

    // MARK: - 校对缓存

    func testProofSaveTruncates500AndLoad() {
        let items: [Any] = (0..<600).map { ["i": $0] }
        let s = data.proofSave(root: dir.path,
                               payload: ["relPath": " 作品/x.md ",
                                         "docHash": "h1", "requestId": "r1", "items": items])
        XCTAssertTrue((s["ok"] as? Bool) == true)
        XCTAssertEqual(s["count"] as? Int64, 500)

        let load = data.proofLoad(root: dir.path, relPath: "作品/x.md")
        let report = dict(load, "report")
        XCTAssertEqual(report["relPath"] as? String, "作品/x.md", "relPath trim 后落盘")
        XCTAssertEqual(report["docHash"] as? String, "h1")
        XCTAssertEqual(report["requestId"] as? String, "r1")
        XCTAssertEqual((report["items"] as? [Any])?.count, 500)
    }

    func testProofSaveRejectsBadPayload() {
        XCTAssertFalse((data.proofSave(root: dir.path, payload: ["items": []])["ok"] as? Bool) == true)
        XCTAssertFalse((data.proofSave(root: dir.path, payload: [String: Any]())["ok"] as? Bool) == true)
    }

    func testProofLoadMissingReportIsNull() {
        let r = data.proofLoad(root: dir.path, relPath: "none/x.md")
        XCTAssertTrue(r["report"] is NSNull)
    }

    func testProofPruneKeepsNewest200() {
        for i in 0..<205 {
            _ = data.proofSave(root: dir.path,
                               payload: ["relPath": "w/p\(i).md", "items": [["i": i]]])
            Thread.sleep(forTimeInterval: 0.003)
        }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: dir.appendingPathComponent("proofread"), includingPropertiesForKeys: nil)) ?? []
        XCTAssertEqual(files.count, 200)
        let oldestLoad = data.proofLoad(root: dir.path, relPath: "w/p0.md")
        XCTAssertTrue(oldestLoad["report"] is NSNull)
        let newestLoad = data.proofLoad(root: dir.path, relPath: "w/p204.md")
        XCTAssertFalse(newestLoad["report"] is NSNull)
    }

    // MARK: - baseline / last-session

    func testBaselineDefaultAndBadFile() throws {
        let d = data.readBaseline()
        let b = dict(d, "baseline")
        XCTAssertEqual(b["version"] as? Int64, 1)
        XCTAssertTrue(b["items"] is [String: Any])

        let syncDir = dir.appendingPathComponent("sync")
        try FileManager.default.createDirectory(at: syncDir, withIntermediateDirectories: true)
        try "garbage".data(using: .utf8)!.write(to: syncDir.appendingPathComponent("baseline.json"))
        let again = data.readBaseline()
        let b2 = dict(again, "baseline")
        XCTAssertEqual(b2["version"] as? Int64, 1)
    }

    func testWriteBaselineAcceptsEmptyMap() {
        let r = data.writeBaseline([:])
        XCTAssertTrue((r["ok"] as? Bool) == true)
        let b = dict(data.readBaseline(), "baseline")
        XCTAssertTrue(b.isEmpty, "空 map 落盘后读回仍为空（缺省 version/items 仅在坏文件时补）")
    }

    func testWriteReadBaselineRoundTrip() {
        let w = data.writeBaseline(["version": 2, "items": ["w/a.md": 123]])
        XCTAssertTrue((w["ok"] as? Bool) == true)
        XCTAssertGreaterThan(w["bytes"] as? Int64 ?? 0, 0)
        let b = dict(data.readBaseline(), "baseline")
        XCTAssertEqual(b["version"] as? Int64, 2)
        XCTAssertEqual(dict(b, "items")["w/a.md"] as? Int64, 123)
    }

    func testLastSessionRoundTripAndMissing() {
        let miss = data.readLastSession()
        XCTAssertTrue(miss["record"] is NSNull)
        let w = data.writeLastSession(["ts": 42, "doc": "w/a.md"])
        XCTAssertTrue((w["ok"] as? Bool) == true)
        let rec = dict(data.readLastSession(), "record")
        XCTAssertEqual(rec["ts"] as? Int64, 42)
        XCTAssertEqual(rec["doc"] as? String, "w/a.md")
    }

    // MARK: - 哈希纯函数（已知向量）

    func testHash12KnownVector() {
        XCTAssertEqual(AppDataStore.hash12(""), "da39a3ee5e6b")
        XCTAssertEqual(AppDataStore.hash12("abc"), "a9993e364706")
        XCTAssertEqual(AppDataStore.hash12(nil), "da39a3ee5e6b")
    }

    func testDraftKeyAndProofCacheKeyKnownLength() {
        let k1 = AppDataStore.draftKeyFor(root: dir.path, relPath: "w/a.md")
        let k2 = AppDataStore.draftKeyFor(root: dir.path + "/", relPath: "w/a.md")
        XCTAssertEqual(k1.count, 24)
        XCTAssertNotEqual(k1, k2, "root 逐字参与哈希，分隔符为换行")
        let pk = AppDataStore.proofCacheKey(forRoot: dir.path, relPath: "w/a.md")
        XCTAssertEqual(pk.count, 40)
        XCTAssertNotEqual(k1, pk)
    }
}
