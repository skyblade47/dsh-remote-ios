import Foundation

final class BridgeDispatcher {

    /// 多工作区模式下它是容器根；单根模式下它就是唯一工作区根。
    private let workspaceRoot: URL
    /// true = 沙盒多工作区（容器下每个子目录一个工作区，当前根可切换/持久化）。
    private let multiWorkspace: Bool
    /// 当前生效的工作区根；多工作区模式首启未选/建时为 nil。
    private var currentRoot: URL?
    private let appVersion: String
    private let appData: AppDataStore
    private let workspace: WorkspaceStore
    private let outbox: OutboxStore
    private let ioLock = NSLock()
    private let now: () -> Date

    init(dataDir: URL, workspaceRoot: URL, multiWorkspace: Bool = false,
         appVersion: String,
         now: @escaping () -> Date = Date.init) throws {
        self.workspaceRoot = workspaceRoot
        self.multiWorkspace = multiWorkspace
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
        if multiWorkspace {
            // 恢复上次选中的容器内子工作区；目录已不在（被删/迁）则回到"未选择"。
            if let name = appData.currentWorkspaceName() {
                let child = workspaceRoot.appendingPathComponent(name, isDirectory: true)
                if isDirectory(child) {
                    self.currentRoot = child.standardizedFileURL
                    self.workspace.rebind(root: child.standardizedFileURL)
                } else {
                    appData.setCurrentWorkspaceName(nil)
                }
            }
        } else {
            self.currentRoot = workspaceRoot
        }
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

    /// 多工作区模式下，这些方法要求已选定一个子工作区。
    private static let requiresRootMethods: Set<String> = [
        "listWorkspace", "readDoc", "writeDoc", "writeDocSync",
        "createWork", "createDoc", "renameWork", "renameDoc", "moveDoc",
        "trashDoc", "trashWork", "listTrash", "restoreTrash", "purgeTrash",
        "writeDraft", "writeDraftSync", "readDraft", "clearDraft",
        "listPendingDrafts", "proofSave", "proofLoad", "appendPomodoro"
    ]

    func dispatch(_ method: String?, args: [Any]) -> [String: Any] {
        ioLock.lock()
        defer { ioLock.unlock() }
        do {
            let m = method ?? ""
            if multiWorkspace, currentRoot == nil,
               Self.requiresRootMethods.contains(m) {
                return Self.fail("尚未选择工作区：请先新建或选择一个沙盒内工作区")
            }
            switch m {
            case "getState":
                return state()
            case "createRoot":
                return try createRoot(str(args, 0), args.count > 1 ? asString(args[1]) : nil)
            case "listRoots":
                return try listRoots()
            case "switchRoot":
                return try switchRoot(str(args, 0))
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
                return appData.writeDraft(root: try currentRootPath(),
                                          relPath: str(args, 0),
                                          content: args.count > 1 ? asString(args[1]) : nil)
            case "readDraft":
                return appData.readDraft(root: try currentRootPath(), relPath: str(args, 0))
            case "clearDraft":
                return appData.clearDraft(root: try currentRootPath(), relPath: str(args, 0))
            case "listPendingDrafts":
                return appData.listPendingDrafts(root: try currentRootPath())
            case "draftsUsage":
                return appData.draftsUsage()
            case "getLastSession":
                return appData.readLastSession()
            case "proofSave":
                return appData.proofSave(root: try currentRootPath(),
                                         payload: args.isEmpty ? [:] : asMap(args[0]))
            case "proofLoad":
                return appData.proofLoad(root: try currentRootPath(),
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

    // MARK: - 首启迁移

    /// 老版本网关经顶部原生条存在 UserDefaults ⇒ 回填 config.json（见 AppDataStore）。
    /// 在 Coordinator 装好 dispatcher 后调用一次；config 已有值时内部不动。
    func seedGatewayFromShellIfNeeded(_ gatewayRaw: String) {
        appData.seedGatewayIfEmpty(gatewayRaw)
    }

    // MARK: - 编排私法

    private func state() -> [String: Any] {
        var s = appData.getState()
        if let root = currentRoot?.path {
            s["root"] = root
            var isDir: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: root, isDirectory: &isDir)
            s["rootExists"] = exists && isDir.boolValue
        } else {
            // 多工作区首启尚未选择：root 显式为 null
            s["root"] = NSNull()
            s["rootExists"] = false
        }
        s["platform"] = "ipad"
        s["appVersion"] = appVersion
        return s
    }

    // MARK: - 沙盒内多工作区

    private func currentRootPath() throws -> String {
        guard let r = currentRoot else {
            throw PathGuard.bad("尚未选择工作区：请先新建或选择一个沙盒内工作区")
        }
        return r.path
    }

    /// 容器下建子工作区：校验名字、mkdir、真写自检，成功后切换为当前根并持久化。
    /// parentDir 仅用于对齐 PC 契约（返回 parentSource 描述），iPad 一律落在容器内。
    private func createRoot(_ nameRaw: String, _ parentDir: String?) throws -> [String: Any] {
        guard multiWorkspace else {
            throw PathGuard.bad("当前为单工作区模式，不支持 createRoot")
        }
        let name = try PathGuard.validateSegment(nameRaw)
        let child = workspaceRoot.appendingPathComponent(name, isDirectory: true)
        if FileManager.default.fileExists(atPath: child.path) {
            throw PathGuard.bad("已存在同名工作区: \(name)")
        }
        do {
            try FileManager.default.createDirectory(at: child,
                                                    withIntermediateDirectories: true)
        } catch {
            throw PathGuard.bad("无法创建工作区: \(error.localizedDescription)")
        }
        // 真写自检：写一个探针文件再删掉，确认目录可写（对齐 PC 的 mkdir+自检）。
        let probe = child.appendingPathComponent(".dsh-probe")
        do {
            try Data("ok".utf8).write(to: probe, options: .atomic)
            try FileManager.default.removeItem(at: probe)
        } catch {
            try? FileManager.default.removeItem(at: child)
            throw PathGuard.bad("工作区不可写: \(error.localizedDescription)")
        }
        let real = child.standardizedFileURL
        currentRoot = real
        workspace.rebind(root: real)
        let saved = appData.setCurrentWorkspaceName(name)
        if saved["ok"] as? Bool != true {
            throw PathGuard.bad((saved["error"] as? String) ?? "当前工作区持久化失败")
        }
        let source = (parentDir?.isEmpty == false) ? parentDir! : "iPad 沙盒容器"
        return ["ok": true, "root": real.path, "name": name, "parentSource": source]
    }

    /// 枚举容器内的子工作区（跳过点开头/回收站/非目录）。
    private func listRoots() throws -> [String: Any] {
        guard multiWorkspace else {
            throw PathGuard.bad("当前为单工作区模式，不支持 listRoots")
        }
        let container = workspaceRoot.standardizedFileURL
        if !FileManager.default.fileExists(atPath: container.path) {
            try FileManager.default.createDirectory(at: container,
                                                    withIntermediateDirectories: true)
        }
        var roots: [[String: Any]] = []
        let entries = (try? FileManager.default.contentsOfDirectory(
            at: container, includingPropertiesForKeys: nil)) ?? []
        let currentName = currentRoot?.lastPathComponent
        for ent in entries {
            let name = ent.lastPathComponent
            guard !name.hasPrefix("."), name != PathGuard.trashDir,
                  isDirectory(ent) else { continue }
            roots.append([
                "name": name,
                "root": ent.standardizedFileURL.path,
                "current": name == currentName
            ])
        }
        roots.sort { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
        return ["ok": true, "container": container.path, "roots": roots]
    }

    /// 切换到容器内已存在的子工作区，成功后重绑 store 并持久化。
    private func switchRoot(_ nameRaw: String) throws -> [String: Any] {
        guard multiWorkspace else {
            throw PathGuard.bad("当前为单工作区模式，不支持 switchRoot")
        }
        let name = try PathGuard.validateSegment(nameRaw)
        let child = workspaceRoot.appendingPathComponent(name, isDirectory: true)
        guard isDirectory(child) else {
            throw PathGuard.bad("工作区不存在: \(name)")
        }
        let real = child.standardizedFileURL
        currentRoot = real
        workspace.rebind(root: real)
        let saved = appData.setCurrentWorkspaceName(name)
        if saved["ok"] as? Bool != true {
            throw PathGuard.bad((saved["error"] as? String) ?? "当前工作区持久化失败")
        }
        return ["ok": true, "root": real.path, "name": name]
    }

    private func isDirectory(_ u: URL) -> Bool {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir)
            && isDir.boolValue
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

        let record = URL(fileURLWithPath: try currentRootPath())
            .appendingPathComponent("番茄钟记录.md")
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
