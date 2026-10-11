import Foundation

final class WorkspaceStore {
    static let maxDocBytes = 2 * 1024 * 1024

    private let root: URL
    private let lock = NSLock()
    private var tmpSeq: Int64 = 0

    private let mdEndCaseInsensitive = try! NSRegularExpression(
        pattern: "\\.[mM][dD]$")

    init(root: URL) {
        self.root = root
    }

    func listWorkspace() throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        var works: [[String: Any]] = []
        let entries = (try? FileManager.default.contentsOfDirectory(at: realRoot,
                                                                    includingPropertiesForKeys: nil)) ?? []
        for ent in entries {
            let name = ent.lastPathComponent
            if name.hasPrefix(".") { continue }
            if name == PathGuard.trashDir { continue }
            let isDir = directoryFlag(ent)
            guard isDir else { continue }
            var docs: [[String: Any]] = []
            let files = (try? FileManager.default.contentsOfDirectory(at: ent,
                                                                      includingPropertiesForKeys: nil)) ?? []
            for f in files {
                let fname = f.lastPathComponent
                guard !directoryFlag(f), !fname.hasPrefix("."),
                      PathGuard.hasMdExt(fname) else { continue }
                docs.append([
                    "name": fname,
                    "relPath": name + "/" + fname,
                    "mtime": mtimeMillis(f)
                ])
            }
            sortByName(&docs)
            works.append(["name": name, "docs": docs])
        }
        sortByName(&works)
        return ["ok": true, "root": realRoot.path, "works": works]
    }

    func readDoc(relPath: String) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = try resolve(realRoot, relPath)
        guard !directoryFlag(abs) else { throw PathGuard.bad("不是文件: \(relPath)") }
        let content = try readText(abs)
        return ["ok": true, "content": content, "mtime": mtimeMillis(abs)]
    }

    func writeDoc(relPath: String, content: String?) throws -> [String: Any] {
        guard let content = content else { throw PathGuard.bad("内容必须是字符串") }
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        try PathGuard.assertMd(relPath)
        let abs = try resolve(realRoot, relPath)
        let data = Data(content.utf8)
        if data.count > Self.maxDocBytes {
            throw PathGuard.bad("文档过大（> 2 MiB）: \(relPath)")
        }
        try mkdir(abs.deletingLastPathComponent())
        try atomicWrite(abs, data)
        return ["ok": true, "mtime": mtimeMillis(abs), "bytes": data.count]
    }

    func createWork(_ name: String) throws -> [String: Any] {
        try PathGuard.validateSegment(name)
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = realRoot.appendingPathComponent(name)
        if FileManager.default.fileExists(atPath: abs.path) {
            throw PathGuard.bad("已存在: \(name)")
        }
        try mkdir(abs)
        return ["ok": true, "work": name]
    }

    func createDoc(work: String, name: String?) throws -> [String: Any] {
        try PathGuard.validateSegment(work)
        let docName = try PathGuard.validateSegment(PathGuard.ensureMd(name))
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = try resolve(realRoot, work + "/" + docName)
        if FileManager.default.fileExists(atPath: abs.path) {
            throw PathGuard.bad("已存在: \(work)/\(docName)")
        }
        try mkdir(abs.deletingLastPathComponent())
        try atomicWrite(abs, Data())
        return ["ok": true, "relPath": work + "/" + docName]
    }

    func renameWork(oldName: String, newName: String) throws -> [String: Any] {
        try PathGuard.validateSegment(oldName)
        try PathGuard.validateSegment(newName)
        lock.lock()
        defer { lock.unlock() }
        if oldName == newName { return ok("work", oldName) }
        let realRoot = try ensureRoot()
        let from = try resolve(realRoot, oldName)
        guard directoryFlag(from) else { throw PathGuard.bad("不是作品目录: \(oldName)") }
        let to = try resolve(realRoot, newName)
        if FileManager.default.fileExists(atPath: to.path) {
            throw PathGuard.bad("已存在同名作品: \(newName)")
        }
        try rename(from, to)
        return ok("work", newName)
    }

    func renameDoc(work: String, oldName: String, newName: String?) throws -> [String: Any] {
        try PathGuard.validateSegment(work)
        let to = try PathGuard.validateSegment(PathGuard.ensureMd(newName))
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let fromName = try PathGuard.assertMd(work + "/" + oldName)
        if fromName == to { return ok("relPath", work + "/" + to) }
        let fromAbs = try resolve(realRoot, work + "/" + fromName)
        guard !directoryFlag(fromAbs) else {
            throw PathGuard.bad("文档不存在: \(work)/\(fromName)")
        }
        let toAbs = try resolve(realRoot, work + "/" + to)
        if FileManager.default.fileExists(atPath: toAbs.path) {
            throw PathGuard.bad("已存在同名文档: \(to)")
        }
        try rename(fromAbs, toAbs)
        return ok("relPath", work + "/" + to)
    }

    func moveDoc(fromWork: String, name: String, toWork: String) throws -> [String: Any] {
        try PathGuard.validateSegment(fromWork)
        try PathGuard.validateSegment(toWork)
        let doc = try PathGuard.assertMd(fromWork + "/" + name)
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        if fromWork == toWork {
            var r = ok("relPath", toWork + "/" + doc)
            r["moved"] = false
            return r
        }
        let fromAbs = try resolve(realRoot, fromWork + "/" + doc)
        guard !directoryFlag(fromAbs) else {
            throw PathGuard.bad("文档不存在: \(fromWork)/\(doc)")
        }
        let toAbs = try resolve(realRoot, toWork + "/" + doc)
        if FileManager.default.fileExists(atPath: toAbs.path) {
            throw PathGuard.bad("目标作品里已有同名文档: \(doc)")
        }
        try mkdir(toAbs.deletingLastPathComponent())
        try rename(fromAbs, toAbs)
        var r = ok("relPath", toWork + "/" + doc)
        r["moved"] = true
        return r
    }

    func trashDoc(work: String, name: String) throws -> [String: Any] {
        try PathGuard.validateSegment(work)
        let doc = try PathGuard.assertMd(work + "/" + name)
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let fromAbs = try resolve(realRoot, work + "/" + doc)
        guard !directoryFlag(fromAbs) else {
            throw PathGuard.bad("文档不存在: \(work)/\(doc)")
        }
        let trashDir = realRoot.appendingPathComponent(PathGuard.trashDir)
            .appendingPathComponent(work)
        let stem = mdEndCaseInsensitive.replaceAll(in: doc)
        let initial = trashDir.appendingPathComponent(
            stem + "-" + PathGuard.trashStampNow() + ".md")
        let target = try PathGuard.uniquePath(initial, isDir: false)
        try mkdir(target.deletingLastPathComponent())
        try rename(fromAbs, target)
        return ok("relPath", relOf(realRoot, target))
    }

    func trashWork(name: String) throws -> [String: Any] {
        try PathGuard.validateSegment(name)
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let fromAbs = try resolve(realRoot, name)
        guard directoryFlag(fromAbs) else { throw PathGuard.bad("不是作品目录: \(name)") }
        let trashBase = realRoot.appendingPathComponent(PathGuard.trashDir)
            .appendingPathComponent(PathGuard.workTrashSub)
        let initial = trashBase.appendingPathComponent(
            name + "-" + PathGuard.trashStampNow())
        let target = try PathGuard.uniquePath(initial, isDir: true)
        try mkdir(target.deletingLastPathComponent())
        try rename(fromAbs, target)
        return ok("relPath", relOf(realRoot, target))
    }

    func listTrash() throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        var items: [[String: Any]] = []
        let base = realRoot.appendingPathComponent(PathGuard.trashDir)
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: base.path, isDirectory: &isDir),
              isDir.boolValue else {
            return trashResult(realRoot, items)
        }
        let tops = (try? FileManager.default.contentsOfDirectory(at: base,
                                                                 includingPropertiesForKeys: nil)) ?? []
        for ent in tops {
            let topName = ent.lastPathComponent
            guard directoryFlag(ent), !topName.hasPrefix(".") else { continue }
            if topName == PathGuard.workTrashSub {
                let subs = (try? FileManager.default.contentsOfDirectory(at: ent,
                                                                         includingPropertiesForKeys: nil)) ?? []
                for s in subs {
                    guard directoryFlag(s), !s.lastPathComponent.hasPrefix(".") else { continue }
                    items.append([
                        "kind": "work",
                        "name": PathGuard.stripTrashStamp(s.lastPathComponent),
                        "trashName": s.lastPathComponent,
                        "work": NSNull(),
                        "relPath": relOf(realRoot, s),
                        "mtime": mtimeMillis(s)
                    ])
                }
                continue
            }
            let files = (try? FileManager.default.contentsOfDirectory(at: ent,
                                                                      includingPropertiesForKeys: nil)) ?? []
            for f in files {
                let fname = f.lastPathComponent
                guard !directoryFlag(f), !fname.hasPrefix("."),
                      PathGuard.hasMdExt(fname) else { continue }
                let stem = PathGuard.stripTrashStamp(mdEndCaseInsensitive.replaceAll(in: fname))
                items.append([
                    "kind": "doc",
                    "name": stem + ".md",
                    "trashName": fname,
                    "work": topName,
                    "relPath": relOf(realRoot, f),
                    "mtime": mtimeMillis(f)
                ])
            }
        }
        items.sort { ln($0["mtime"]) > ln($1["mtime"]) }
        return trashResult(realRoot, items)
    }

    func restoreTrash(relPath: String) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = try resolve(realRoot, relPath)
        guard FileManager.default.fileExists(atPath: abs.path) else {
            throw PathGuard.bad("回收站条目不存在: \(relPath)")
        }
        let segs = try PathGuard.splitRel(relOf(realRoot, abs))
        guard segs[0] == PathGuard.trashDir, segs.count >= 3 else {
            throw PathGuard.bad("不是回收站内的条目: \(relPath)")
        }
        if segs[1] == PathGuard.workTrashSub {
            guard directoryFlag(abs) else {
                throw PathGuard.bad("回收站条目类型不符: \(relPath)")
            }
            let name = PathGuard.stripTrashStamp(segs[2])
            if name.isEmpty || name == segs[2] {
                throw PathGuard.bad("条目名没有软删时间戳，无法还原原名: \(segs[2])")
            }
            try PathGuard.validateSegment(name)
            let toAbs = try resolve(realRoot, name)
            if FileManager.default.fileExists(atPath: toAbs.path) {
                throw PathGuard.bad("已存在同名作品，无法恢复: \(name)")
            }
            try rename(abs, toAbs)
            return ["ok": true, "kind": "work", "work": name]
        }
        guard !directoryFlag(abs) else {
            throw PathGuard.bad("回收站条目类型不符: \(relPath)")
        }
        let work = segs[1]
        try PathGuard.validateSegment(work)
        let stem = PathGuard.stripTrashStamp(mdEndCaseInsensitive.replaceAll(in: segs[2]))
        if stem.isEmpty {
            throw PathGuard.bad("条目名没有软删时间戳，无法还原原名: \(segs[2])")
        }
        let docName = stem + ".md"
        try PathGuard.validateSegment(docName)
        let toAbs = try resolve(realRoot, work + "/" + docName)
        if FileManager.default.fileExists(atPath: toAbs.path) {
            throw PathGuard.bad("原位置已有同名文档，无法恢复: \(work)/\(docName)")
        }
        try mkdir(toAbs.deletingLastPathComponent())
        try rename(abs, toAbs)
        return ["ok": true, "kind": "doc", "relPath": work + "/" + docName]
    }

    func purgeTrash(relPath: String) throws -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let realRoot = try ensureRoot()
        let abs = try resolve(realRoot, relPath)
        let rel = relOf(realRoot, abs)
        let segs = try PathGuard.splitRel(rel)
        guard segs[0] == PathGuard.trashDir, segs.count >= 2 else {
            throw PathGuard.bad("只能彻底删除回收站内的条目: \(relPath)")
        }
        guard FileManager.default.fileExists(atPath: abs.path) else {
            throw PathGuard.bad("回收站条目不存在: \(relPath)")
        }
        do {
            try FileManager.default.removeItem(at: abs)
        } catch {
            throw PathGuard.bad("彻底删除失败: \(error.localizedDescription)")
        }
        return ok("relPath", rel)
    }

    private func ensureRoot() throws -> URL {
        var isDir: ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: root.path, isDirectory: &isDir)
        if !exists {
            do {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("工作区根无法创建: \(root.path)")
            }
        } else if !isDir.boolValue {
            throw PathGuard.bad("工作区根不是目录: \(root.path)")
        }
        return root.standardizedFileURL.resolvingSymlinksInPath()
    }

    private func resolve(_ realRoot: URL, _ relPath: String) throws -> URL {
        do {
            return try PathGuard.resolveInRoot(root: realRoot, relPath: relPath)
        } catch {
            let msg = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
            throw PathGuard.bad("路径解析失败: \(msg)")
        }
    }

    private func mkdir(_ d: URL) throws {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: d.path, isDirectory: &isDir) { return }
        do {
            try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        } catch {
            throw PathGuard.bad("无法创建目录: \(d.path)")
        }
    }

    private func atomicWrite(_ abs: URL, _ data: Data) throws {
        tmpSeq += 1
        let tmp = abs.deletingLastPathComponent()
            .appendingPathComponent(abs.lastPathComponent + ".tmp-\(tmpSeq)")
        do {
            try data.write(to: tmp, options: .atomic)
            try move(tmp, abs)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw PathGuard.bad("写入失败: \(error.localizedDescription)")
        }
    }

    private func move(_ src: URL, _ dst: URL) throws {
        do {
            if FileManager.default.fileExists(atPath: dst.path) {
                try FileManager.default.removeItem(at: dst)
            }
            try FileManager.default.moveItem(at: src, to: dst)
        } catch {
            do {
                let bytes = try Data(contentsOf: src)
                try bytes.write(to: dst, options: .atomic)
                try FileManager.default.removeItem(at: src)
            } catch {
                throw PathGuard.bad("写入失败: \(error.localizedDescription)")
            }
        }
    }

    private func rename(_ src: URL, _ dst: URL) throws {
        do {
            try move(src, dst)
        } catch {
            throw PathGuard.bad("重命名失败: \(error.localizedDescription)")
        }
    }

    private func readText(_ abs: URL) throws -> String {
        let raw: Data
        do {
            raw = try Data(contentsOf: abs)
        } catch {
            throw PathGuard.bad("读取失败: \(error.localizedDescription)")
        }
        var s = String(decoding: raw, as: UTF8.self)
        if s.first == "\u{FEFF}" { s.removeFirst() }
        return s
    }

    private func relOf(_ realRoot: URL, _ abs: URL) -> String {
        let base = realRoot.standardizedFileURL.path
        var target = abs.standardizedFileURL.path
        if target.hasPrefix(base) {
            target.removeFirst(base.count)
            if target.hasPrefix("/") { target.removeFirst() }
        }
        return target
    }

    private func trashResult(_ realRoot: URL, _ items: [[String: Any]]) -> [String: Any] {
        ["ok": true, "root": realRoot.path, "items": items]
    }

    private func ok(_ key: String, _ value: Any) -> [String: Any] {
        ["ok": true, key: value]
    }

    private func sortByName(_ list: inout [[String: Any]]) {
        list.sort { str($0["name"]) < str($1["name"]) }
    }

    private func str(_ o: Any?) -> String {
        if let s = o as? String { return s }
        return o.map { String(describing: $0) } ?? ""
    }

    private func ln(_ o: Any?) -> Int64 {
        (o as? NSNumber)?.int64Value ?? 0
    }

    private func mtimeMillis(_ u: URL) -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: u.path),
              let date = attrs[.modificationDate] as? Date else { return 0 }
        return Int64((date.timeIntervalSince1970 * 1000.0).rounded())
    }

    private func directoryFlag(_ u: URL) -> Bool {
        var isDir: ObjCBool = false
        if FileManager.default.fileExists(atPath: u.path, isDirectory: &isDir) {
            return isDir.boolValue
        }
        return false
    }
}

private extension NSRegularExpression {
    func replaceAll(in s: String, template: String = "") -> String {
        stringByReplacingMatches(in: s,
                                 range: NSRange(s.startIndex..., in: s),
                                 withTemplate: template)
    }
}
