import Foundation

final class BridgeDispatcher {

    private let workspaceRoot: URL
    private let appVersion: String
    private let appData: AppDataStore
    private let workspace: WorkspaceStore
    private let outbox: OutboxStore
    private let ioLock = NSLock()
    private let now: () -> Date

    init(dataDir: URL, workspaceRoot: URL, appVersion: String,
         now: @escaping () -> Date = Date.init) throws {
        self.workspaceRoot = workspaceRoot
        self.appVersion = appVersion
        self.now = now
        let fm = FileManager.default
        if !fm.fileExists(atPath: dataDir.path) {
            do {
                try fm.createDirectory(at: dataDir, withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("无法创建数据目录: \(dataDir.path)")
            }
        }
        if !fm.fileExists(atPath: workspaceRoot.path) {
            do {
                try fm.createDirectory(at: workspaceRoot, withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("无法创建工作区目录: \(workspaceRoot.path)")
            }
        }
        self.appData = AppDataStore(dataDir: dataDir)
        self.workspace = WorkspaceStore(root: workspaceRoot)
        self.outbox = OutboxStore(dataDir: dataDir)
    }

    // MARK: - 两个入口

    func dispatch(_ method: String?, argsJson: String?) -> [String: Any] {
        let parsed: Any?
        do {
            parsed = try JSONSerialization.jsonObject(
                with: Data((argsJson ?? "[]").utf8), options: [.fragmentsAllowed])
        } catch {
            return Self.fail("参数必须是 JSON 数组: \(error.localizedDescription)")
        }
        let args: [Any]
        switch parsed {
        case nil, is NSNull:
            args = []
        case let arr as [Any]:
            args = arr
        default:
            return Self.fail("参数必须是 JSON 数组: 收到非数组参数（对象/标量）")
        }
        return dispatch(method, args: args)
    }

    func dispatch(_ method: String?, args: [Any]) -> [String: Any] {
        ioLock.lock()
        defer { ioLock.unlock() }
        do {
            switch method ?? "" {
            case "getState":
                return state()
            case "listWorkspace":
                return try workspace.listWorkspace()
            case "readDoc":
                return try workspace.readDoc(relPath: str(args, 0))
            case "writeDoc", "writeDocSync":
                return try writeDoc(str(args, 0), args.count > 1 ? asString(args[1]) : nil)
            case "createWork":
                return try workspace.createWork(str(args, 0))
            case "createDoc":
                return try workspace.createDoc(work: str(args, 0),
                                               name: args.count > 1 ? asString(args[1]) : "")
            case "renameWork":
                return try workspace.renameWork(oldName: str(args, 0), newName: str(args, 1))
            case "renameDoc":
                return try workspace.renameDoc(work: str(args, 0),
                                               oldName: str(args, 1),
                                               newName: str(args, 2))
            case "moveDoc":
                return try workspace.moveDoc(fromWork: str(args, 0),
                                             name: str(args, 1),
                                             toWork: str(args, 2))
            case "trashDoc":
                return try workspace.trashDoc(work: str(args, 0), name: str(args, 1))
            case "trashWork":
                return try workspace.trashWork(name: str(args, 0))
            case "listTrash":
                return try workspace.listTrash()
            case "restoreTrash":
                return try workspace.restoreTrash(relPath: str(args, 0))
            case "purgeTrash":
                return try workspace.purgeTrash(relPath: str(args, 0))
            case "saveConfig":
                return appData.saveConfig(args.isEmpty ? [:] : asMap(args[0]))
            case "writeDraft", "writeDraftSync":
                return appData.writeDraft(root: workspaceRoot.path,
                                          relPath: str(args, 0),
                                          content: args.count > 1 ? asString(args[1]) : nil)
            case "readDraft":
                return appData.readDraft(root: workspaceRoot.path, relPath: str(args, 0))
            case "clearDraft":
                return appData.clearDraft(root: workspaceRoot.path, relPath: str(args, 0))
            case "listPendingDrafts":
                return appData.listPendingDrafts(root: workspaceRoot.path)
            case "draftsUsage":
                return appData.draftsUsage()
            case "getLastSession":
                return appData.readLastSession()
            case "proofSave":
                return appData.proofSave(root: workspaceRoot.path,
                                         payload: args.isEmpty ? [:] : asMap(args[0]))
            case "proofLoad":
                return appData.proofLoad(root: workspaceRoot.path,
                                         relPath: str(args, 0))
            case "syncBaseline":
                return appData.readBaseline()
            case "syncBaselineSet":
                return appData.writeBaseline(args.isEmpty ? [:] : asMap(args[0]))
            case "appendPomodoro":
                return try appendPomodoro(args.isEmpty ? nil : args[0])
            case "outboxList":
                return ["ok": true, "entries": outbox.list()]
            case "outboxRemove":
                outbox.remove(str(args, 0))
                return okMap()
            case "hash12":
                return ["ok": true,
                        "hash": AppDataStore.hash12(args.isEmpty ? "" : asString(args[0]))]
            case "reportDirty", "onFlushRequest", "flushDone", "relaunch",
                 "scheduleReminder", "cancelReminder", "getDeviceId",
                 "notifyWriting", "nativeOnline":
                return okMap()
            case "pickRoot", "pickDir", "pickImportFiles", "pickImportDir",
                 "importInto", "onImportProgress":
                return Self.unsupported()
            default:
                return Self.fail("未知方法: \(method ?? "")")
            }
        } catch {
            return Self.fail(error.localizedDescription)
        }
    }

    // MARK: - 编排私法

    private func state() -> [String: Any] {
        var s = appData.getState()
        s["root"] = workspaceRoot.path
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: workspaceRoot.path,
                                                    isDirectory: &isDir)
        s["rootExists"] = exists && isDir.boolValue
        s["platform"] = "ipad"
        s["appVersion"] = appVersion
        return s
    }

    private func writeDoc(_ relPath: String, _ content: String?) throws -> [String: Any] {
        let r = try workspace.writeDoc(relPath: relPath, content: content)
        if r["ok"] as? Bool == true {
            do {
                try outbox.add(relPath)
            } catch {
                // 对齐蓝本：入队失败不影响写入结果
            }
        }
        return r
    }

    private func appendPomodoro(_ payloadObj: Any?) throws -> [String: Any] {
        guard let payload = payloadObj as? [String: Any] else {
            throw PathGuard.bad("payload 必须是对象")
        }
        let focusMin: Int64
        if let n = payload["focusMin"] as? NSNumber {
            focusMin = CFNumberIsFloatType(n as CFNumber)
                ? Int64(n.doubleValue.rounded()) : n.int64Value
        } else {
            focusMin = 25
        }
        let doc = (payload["doc"] as? String) ?? ""

        let record = workspaceRoot.appendingPathComponent("番茄钟记录.md")
        let fm = FileManager.default
        try fm.createDirectory(at: record.deletingLastPathComponent(),
                               withIntermediateDirectories: true)
        let prev = fm.fileExists(atPath: record.path)
            ? (try? String(contentsOf: record, encoding: .utf8)) ?? "" : ""
        let line: Int64 = prev.isEmpty ? 1 : countLines(prev) + 1
        let stamp = Self.pomodoroFormatter.string(from: now())
        var row = "\(line). \(stamp) · 专注 \(focusMin) 分钟"
        if !doc.isEmpty { row += " · \(doc)" }
        row += "\n"
        let rowData = Data(row.utf8)
        if fm.fileExists(atPath: record.path),
           let h = try? FileHandle(forWritingTo: record) {
            defer { try? h.close() }
            try h.seekToEnd()
            try h.write(contentsOf: rowData)
        } else {
            try rowData.write(to: record, options: .atomic)
        }
        return ["ok": true, "file": record.path, "line": line]
    }

    private static let pomodoroFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Shanghai")
        f.dateFormat = "yyyy-MM-dd HH:mm"
        return f
    }()

    private func countLines(_ s: String) -> Int64 {
        var n: Int64 = 0
        for ch in s where ch == "\n" { n += 1 }
        if s.isEmpty || s.last != "\n" { n += 1 }
        return n
    }

    // MARK: - 参数/返回工具

    private func str(_ args: [Any], _ i: Int) -> String {
        i < args.count ? (asString(args[i]) ?? "") : ""
    }

    private func asString(_ o: Any?) -> String? {
        guard let o = o else { return nil }
        if let s = o as? String { return s }
        if o is NSNull { return nil }
        return String(describing: o)
    }

    private func asMap(_ o: Any?) -> [String: Any] {
        (o as? [String: Any]) ?? [:]
    }

    private func okMap() -> [String: Any] { ["ok": true] }

    private static func fail(_ msg: String?) -> [String: Any] {
        ["ok": false, "error": msg ?? "未知错误"]
    }

    private static func unsupported() -> [String: Any] {
        ["ok": false, "error": "NotSupported: iPad v1 不支持选目录/导入"]
    }
}
