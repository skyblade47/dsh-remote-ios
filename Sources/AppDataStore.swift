import Foundation
import CryptoKit

final class AppDataStore {
    static let defaultPort: Int64 = 18080
    static let proofCacheMax = 200
    static let proofItemsMax = 500
    static let defaultDailyGoal: Int64 = 1000
    static let defaultReminderTime = "20:00"
    static let defaultIntents = ["错字/病句检查", "结构诊断", "续写"]

    private static let reminderTimePattern =
        try! NSRegularExpression(pattern: "^([01]\\d|2[0-3]):[0-5]\\d$")
    private static let sessionPattern =
        try! NSRegularExpression(pattern: "^session-[A-Za-z0-9._-]{6,}$")
    private static let gatewayPattern =
        try! NSRegularExpression(pattern: "^https?://[^\\s/]+.*")

    private let dataDir: URL
    private let lock = NSLock()
    private var tmpSeq: Int64 = 0

    init(dataDir: URL) {
        self.dataDir = dataDir
    }

    // MARK: - getState

    func getState() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let cfg = readConfig()
        let root = cfg["workspaceRoot"] as? String
        let rootStr = (root?.isEmpty == false) ? root : nil

        var s: [String: Any] = [:]
        s["ok"] = true
        s["root"] = rootStr ?? NSNull()
        s["rootExists"] = rootStr != nil && FileManager.default.fileExists(atPath: rootStr!)
        s["pomodoro"] = mergePomodoro(cfg["pomodoro"], nil)
        s["settings"] = settingsConfig(cfg)
        s["ui"] = (cfg["ui"] as? [String: Any]).map { deepCopy($0) } ?? [String: Any]()
        s["proofread"] = normalizeProofread(cfg["proofread"])
        s["writingPrefs"] = normalizeWritingPrefs(cfg["writingPrefs"] as? [String: Any])
        s["draftsDir"] = dataDir.appendingPathComponent("drafts").path
        return s
    }

    // MARK: - saveConfig

    func saveConfig(_ patch: [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        var prev = readConfig()
        var next = prev

        if patch["pomodoro"] != nil {
            next["pomodoro"] = mergePomodoro(prev["pomodoro"], patch["pomodoro"])
        }
        if patch["ui"] != nil {
            var ui = (prev["ui"] as? [String: Any]).map { $0 } ?? [:]
            if let patchUi = patch["ui"] as? [String: Any] {
                for (k, v) in patchUi {
                    if k == "split", let ps = v as? [String: Any] {
                        var split = (ui["split"] as? [String: Any]) ?? [:]
                        if ps["ratio"] != nil {
                            split["ratio"] = clampDouble(ps["ratio"], 0.2, 0.8, 0.5)
                        }
                        if ps["on"] != nil { split["on"] = Self.strictBool(ps["on"]) }
                        ui["split"] = split
                    } else {
                        ui[k] = v
                    }
                }
            }
            next["ui"] = ui
        }
        if patch["proofread"] != nil {
            next["proofread"] = normalizeProofread(patch["proofread"])
        }
        if patch["send"] != nil {
            let p = asMap(patch["send"])
            next["send"] = ["intents": normalizeIntentList(p["intents"])]
        }
        if patch["autosave"] != nil {
            let p = asMap(patch["autosave"])
            next["autosave"] = ["debounceMs": clampLong(p["debounceMs"], 200, 10000, 1000)]
        }
        if patch["drafts"] != nil {
            next["drafts"] = mergeDrafts(prev["drafts"], patch["drafts"])
        }
        if patch["theme"] != nil {
            let theme = Self.stringOf(patch["theme"])
            next["theme"] = ["auto", "light", "dark"].contains(theme) ? theme : "auto"
        }
        if patch["general"] != nil {
            let pg = asMap(patch["general"])
            next["general"] = [
                "autoStart": Self.strictBool(pg["autoStart"]),
                "tray": !Self.falseBool(pg["tray"])
            ]
        }
        if patch["editor"] != nil {
            next["editor"] = normalizeEditor(asMap(prev["editor"]), asMap(patch["editor"]))
        }
        if patch["preview"] != nil {
            next["preview"] = normalizePreview(asMap(prev["preview"]), asMap(patch["preview"]))
        }
        if patch["remote"] != nil {
            var remote = asMap(prev["remote"])
            let pr = asMap(patch["remote"])
            if let mode = pr["mode"] {
                remote["mode"] = (mode as? String == "manual" || mode as? String == "auto")
                    ? mode : "auto"
            }
            if pr["gateway"] != nil {
                let gw = Self.stringOf(pr["gateway"]).trimmingJava()
                if !Self.gatewayPattern.hasMatch(gw) {
                    return fail("BadRequest: gateway 必须是 http(s):// 地址")
                }
                remote["gateway"] = gw
            }
            if pr["port"] != nil {
                remote["port"] = clampLong(pr["port"], 1024, 65535, Self.defaultPort)
            }
            next["remote"] = remote
        }
        if patch["writingPrefs"] != nil {
            next["writingPrefs"] = mergeWritingPrefs(prev["writingPrefs"], patch["writingPrefs"])
        }

        do {
            try writeConfig(next)
        } catch {
            return fail(error.localizedDescription)
        }
        _ = prev

        var configView: [String: Any] = [:]
        configView["pomodoro"] = next["pomodoro"] ?? NSNull()
        configView["ui"] = next["ui"] ?? NSNull()
        configView["proofread"] = next["proofread"] ?? NSNull()
        configView["writingPrefs"] = next["writingPrefs"] ?? NSNull()

        return [
            "ok": true,
            "config": configView,
            "settings": settingsConfig(next)
        ]
    }

    // MARK: - 草稿

    func writeDraft(root: String, relPath: String, content: String?) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        guard let content = content else { return fail("内容必须是字符串") }
        let maxBytes = draftsLimits(readConfig()).maxBytes
        let bytes = Array(content.utf8)
        if Int64(bytes.count) > maxBytes {
            return fail("草稿过大（\(bytes.count) > \(maxBytes) 字节），未写草稿")
        }
        let key = Self.draftKeyFor(root: root, relPath: relPath)
        let dir = dataDir.appendingPathComponent("drafts")
        do {
            try mkdirs(dir)
            let md = dir.appendingPathComponent(key + ".md")
            try atomicWrite(md, Data(bytes))
            let mtime = mtimeMillis(md)

            let segs = Self.stringOf(relPath).replacingOccurrences(of: "\\", with: "/")
                .components(separatedBy: "/")
            var meta: [String: Any] = [:]
            meta["key"] = key
            meta["root"] = Self.stringOf(root)
            meta["relPath"] = Self.stringOf(relPath)
            meta["work"] = segs.count > 1 ? segs[0] : ""
            meta["name"] = segs[segs.count - 1]
            meta["savedAt"] = nowMillis()
            meta["draftMtime"] = mtime
            meta["bytes"] = Int64(bytes.count)
            try writeWhole(dir.appendingPathComponent(key + ".json"),
                           text: jsonStringify(meta))
            pruneDrafts(draftsLimits(readConfig()))
            return ["ok": true, "key": key, "mtime": mtime, "bytes": Int64(bytes.count)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func readDraft(root: String, relPath: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let md = dataDir.appendingPathComponent("drafts")
            .appendingPathComponent(Self.draftKeyFor(root: root, relPath: relPath) + ".md")
        do {
            return ["ok": true, "content": try readText(md)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func clearDraft(root: String, relPath: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let key = Self.draftKeyFor(root: root, relPath: relPath)
        let dir = dataDir.appendingPathComponent("drafts")
        var cleared: Int64 = 0
        for name in [key + ".md", key + ".json"] {
            let f = dir.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: f.path) {
                do {
                    try FileManager.default.removeItem(at: f)
                    cleared += 1
                } catch { }
            }
        }
        return ["ok": true, "cleared": cleared]
    }

    func draftsUsage() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let limits = draftsLimits(readConfig())
        let dir = dataDir.appendingPathComponent("drafts")
        var files: Int64 = 0
        var bytes: Int64 = 0
        let list = (try? FileManager.default.contentsOfDirectory(at: dir,
                                                                 includingPropertiesForKeys: nil)) ?? []
        for f in list where f.lastPathComponent.hasSuffix(".md") {
            files += 1
            bytes += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return [
            "dir": dir.path,
            "files": files,
            "bytes": bytes,
            "limitFiles": limits.maxFiles,
            "limitBytes": limits.maxTotalBytes
        ]
    }

    func listPendingDrafts(root: String) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let dir = dataDir.appendingPathComponent("drafts")
        var out: [[String: Any]] = []
        let list = (try? FileManager.default.contentsOfDirectory(at: dir,
                                                                 includingPropertiesForKeys: nil)) ?? []
        for f in list where f.lastPathComponent.hasSuffix(".json") {
            guard let text = try? readText(f),
                  let parsed = try? jsonParse(text),
                  let meta = parsed as? [String: Any] else { continue }
            guard let relPath = meta["relPath"] as? String, safeRelPath(relPath) else { continue }
            let metaRoot = Self.stringOf(meta["root"])
            guard metaRoot == root else { continue }

            let md = dir.appendingPathComponent(Self.draftKeyFor(root: metaRoot, relPath: relPath) + ".md")
            var isDir: ObjCBool = false
            guard FileManager.default.fileExists(atPath: md.path, isDirectory: &isDir),
                  !isDir.boolValue else { continue }
            let draftMtime = mtimeMillis(md)
            let draftBytes = Int64((try? md.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)

            let formal = URL(fileURLWithPath: root)
                .appendingPathComponent(relPath.replacingOccurrences(of: "/", with: "/"))
            var fDir: ObjCBool = false
            let formalExists = FileManager.default.fileExists(atPath: formal.path, isDirectory: &fDir)
                && !fDir.boolValue
            let formalMtime = formalExists ? mtimeMillis(formal) : 0
            if formalExists && draftMtime <= formalMtime {
                _ = clearDraftLocked(metaRoot, relPath)
                continue
            }
            out.append([
                "relPath": relPath,
                "work": meta["work"] ?? "",
                "name": meta["name"] ?? "",
                "savedAt": meta["savedAt"] ?? 0,
                "draftMtime": draftMtime,
                "bytes": draftBytes,
                "formalExists": formalExists,
                "formalMtime": formalMtime
            ])
        }
        out.sort { int64($0["draftMtime"]) > int64($1["draftMtime"]) }
        return ["ok": true, "root": root, "drafts": out]
    }

    // MARK: - 校对缓存

    func proofSave(root: String, payload: [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let relObj = payload["relPath"]
        let rel = (relObj as? String)?.trimmingJava() ?? ""
        if rel.isEmpty { return fail("BadRequest: 缺 relPath") }

        var items: [Any] = []
        if let raw = payload["items"] as? [Any] {
            for it in raw {
                if items.count >= Self.proofItemsMax { break }
                items.append(it)
            }
        }
        var rec: [String: Any] = [:]
        rec["relPath"] = rel
        rec["at"] = nowMillis()
        rec["docHash"] = (payload["docHash"] as? String) ?? ""
        rec["requestId"] = (payload["requestId"] as? String) ?? ""
        rec["items"] = items

        let dir = dataDir.appendingPathComponent("proofread")
        do {
            try mkdirs(dir)
            try writeWhole(dir.appendingPathComponent(
                Self.proofCacheKey(forRoot: root, relPath: rel) + ".json"),
                text: jsonStringify(rec))
            proofPrune()
            return ["ok": true, "count": Int64(items.count)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func proofLoad(root: String, relPath: String?) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let rel = (relPath ?? "").trimmingJava()
        if rel.isEmpty { return fail("BadRequest: 缺 relPath") }
        let f = dataDir.appendingPathComponent("proofread")
            .appendingPathComponent(Self.proofCacheKey(forRoot: root, relPath: rel) + ".json")
        var report: Any = NSNull()
        if let text = try? readText(f),
           let parsed = try? jsonParse(text),
           let map = parsed as? [String: Any],
           map["items"] is [Any] {
            report = map
        }
        return ["ok": true, "report": report]
    }

    // MARK: - baseline / last-session

    func readBaseline() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let f = dataDir.appendingPathComponent("sync").appendingPathComponent("baseline.json")
        var parsed: Any?
        if let text = try? readText(f), let p = try? jsonParse(text) {
            parsed = (p as? [String: Any]) != nil ? p : nil
        }
        let baseline: [String: Any]
        if let m = parsed as? [String: Any] {
            baseline = m
        } else {
            baseline = ["version": Int64(1), "items": [String: Any]()]
        }
        return ["ok": true, "baseline": baseline]
    }

    func writeBaseline(_ map: [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let f = dataDir.appendingPathComponent("sync").appendingPathComponent("baseline.json")
        do {
            try mkdirs(f.deletingLastPathComponent())
            let bytes = Data(try jsonStringify(map).utf8)
            try atomicWrite(f, bytes)
            return ["ok": true, "bytes": Int64(bytes.count)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func writeLastSession(_ rec: [String: Any]) -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let f = dataDir.appendingPathComponent("last-session.json")
        do {
            try mkdirs(f.deletingLastPathComponent())
            let bytes = Data(try jsonStringify(rec).utf8)
            try atomicWrite(f, bytes)
            return ["ok": true, "bytes": Int64(bytes.count)]
        } catch {
            return fail(error.localizedDescription)
        }
    }

    func readLastSession() -> [String: Any] {
        lock.lock()
        defer { lock.unlock() }
        let f = dataDir.appendingPathComponent("last-session.json")
        var record: Any = NSNull()
        if let text = try? readText(f),
           let parsed = try? jsonParse(text),
           let map = parsed as? [String: Any] {
            record = map
        }
        return ["ok": true, "record": record]
    }

    // MARK: - 哈希（静态纯函数）

    static func hash12(_ text: String?) -> String {
        String(sha1Hex(text ?? "").prefix(12))
    }

    static func draftKeyFor(root: String, relPath: String) -> String {
        String(sha1Hex(stringOf(root) + "\n" + stringOf(relPath)).prefix(24))
    }

    static func proofCacheKey(forRoot root: String, relPath: String) -> String {
        String(sha1Hex(stringOf(root) + "|" + stringOf(relPath)).prefix(40))
    }

    static func sha1Hex(_ input: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data(input.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - 配置归一化

    private struct DraftLimits {
        let maxFiles: Int64
        let maxBytes: Int64
        let maxTotalBytes: Int64
    }

    private func draftsLimits(_ cfg: [String: Any]) -> DraftLimits {
        let d = asMap(cfg["drafts"])
        return DraftLimits(
            maxFiles: clampLong(d["maxFiles"], 1, 10000, 200),
            maxBytes: clampLong(d["maxBytes"], 1024, 256 * 1024 * 1024, 5 * 1024 * 1024),
            maxTotalBytes: clampLong(d["maxTotalBytes"], 1024 * 1024,
                                     4 * 1024 * 1024 * 1024, 128 * 1024 * 1024)
        )
    }

    private func mergePomodoro(_ prevObj: Any?, _ patchObj: Any?) -> [String: Any] {
        var merged = asMap(prevObj)
        if let patch = patchObj as? [String: Any] {
            for (k, v) in patch { merged[k] = v }
        }
        return [
            "focusMin": clampLong(merged["focusMin"], 1, 180, 25),
            "breakMin": clampLong(merged["breakMin"], 1, 60, 5),
            "autoNext": !Self.falseBool(merged["autoNext"])
        ]
    }

    private func mergeDrafts(_ prevObj: Any?, _ patchObj: Any?) -> [String: Any] {
        let prev = asMap(prevObj)
        let patch = asMap(patchObj)
        let old = draftsLimits(prev)
        let maxFiles = patch["maxFiles"] != nil
            ? clampLong(patch["maxFiles"], 1, 10000, old.maxFiles) : old.maxFiles
        let maxBytes = patch["maxBytes"] != nil
            ? clampLong(patch["maxBytes"], 1024, 256 * 1024 * 1024, old.maxBytes)
            : old.maxBytes
        let maxTotal = patch["maxTotalBytes"] != nil
            ? clampLong(patch["maxTotalBytes"], 1024 * 1024,
                        4 * 1024 * 1024 * 1024, old.maxTotalBytes) : old.maxTotalBytes
        let notify: Bool
        if patch["notifyOnStartup"] != nil {
            notify = !Self.falseBool(patch["notifyOnStartup"])
        } else {
            notify = !Self.falseBool(prev["notifyOnStartup"])
        }
        return ["maxFiles": maxFiles, "maxBytes": maxBytes,
                "maxTotalBytes": maxTotal, "notifyOnStartup": notify]
    }

    private func settingsConfig(_ cfg: [String: Any]) -> [String: Any] {
        var s: [String: Any] = [:]
        s["autosave"] = ["debounceMs": clampLong(asMap(cfg["autosave"])["debounceMs"],
                                                 200, 10000, 1000)]
        let dl = draftsLimits(cfg)
        s["drafts"] = [
            "maxFiles": dl.maxFiles,
            "maxBytes": dl.maxBytes,
            "maxTotalBytes": dl.maxTotalBytes,
            "notifyOnStartup": !Self.falseBool(asMap(cfg["drafts"])["notifyOnStartup"])
        ]
        let theme = cfg["theme"]
        s["theme"] = (theme as? String).map { ["auto", "light", "dark"].contains($0) ? $0 : "auto" }
            ?? "auto"
        let pg = asMap(cfg["general"])
        s["general"] = [
            "autoStart": Self.strictBool(pg["autoStart"]),
            "tray": !Self.falseBool(pg["tray"])
        ]
        let sendRaw = asMap(cfg["send"])["intents"]
        s["send"] = ["intents": sendRaw == nil ? type(of: self).defaultIntents
                                          : normalizeIntentList(sendRaw)]
        s["editor"] = normalizedKnownEditor(asMap(cfg["editor"]))
        s["preview"] = normalizedKnownPreview(asMap(cfg["preview"]))

        let pr = asMap(cfg["remote"])
        let gwStr = (pr["gateway"] as? String)?.trimmingJava() ?? ""
        s["remote"] = [
            "mode": (pr["mode"] as? String == "manual") ? "manual" : "auto",
            "gateway": Self.gatewayPattern.hasMatch(gwStr) ? gwStr : "",
            "port": clampLong(pr["port"], 1024, 65535, Self.defaultPort)
        ]
        return s
    }

    private func normalizeEditor(_ prev: [String: Any], _ patch: [String: Any]) -> [String: Any] {
        var merged = prev
        for (k, v) in patch { merged[k] = v }
        return normalizedKnownEditor(merged)
    }

    private func normalizedKnownEditor(_ e: [String: Any]) -> [String: Any] {
        var out = e
        out["fontSize"] = clampFontSize(e["fontSize"])
        let family = e["fontFamily"] as? String
        out["fontFamily"] = ["kai", "mono", "serif", "sans", "dsh"].contains(family) ? family : "kai"
        out["lineHeight"] = clampOptionalDouble(e["lineHeight"], 1.4, 2.4, digits: 2)
        out["letterSpacing"] = clampOptionalDouble(e["letterSpacing"], 0, 0.1, digits: 3)
        out["measure"] = clampOptionalLong(e["measure"], 20, 48)
        let preset = e["colorPreset"] as? String
        out["colorPreset"] = ["default", "sepia", "green"].contains(preset) ? preset : "default"
        return out
    }

    private func normalizePreview(_ prev: [String: Any], _ patch: [String: Any]) -> [String: Any] {
        var merged = prev
        for (k, v) in patch { merged[k] = v }
        return normalizedKnownPreview(merged)
    }

    private func normalizedKnownPreview(_ p: [String: Any]) -> [String: Any] {
        var out = p
        out["fontSize"] = clampFontSize(p["fontSize"])
        out["lineHeight"] = clampOptionalDouble(p["lineHeight"], 1.4, 2.4, digits: 2)
        let family = p["fontFamily"] as? String
        out["fontFamily"] = ["auto", "mono", "serif", "sans"].contains(family) ? family : "auto"
        out["paraSpacing"] = normalizeParaSpacing(p["paraSpacing"])
        out["indent"] = clampLong(p["indent"], 0, 2, 0)
        return out
    }

    private func normalizeParaSpacing(_ v: Any?) -> Any {
        guard let v = v else { return "auto" }
        if let s = v as? String {
            if s.isEmpty || s == "auto" { return "auto" }
            let n = toDouble(s)
            if !n.isFinite || n < 0 { return "auto" }
            return round(Swift.min(2, n), digits: 2)
        }
        if v is NSNumber {
            let n = toDouble(v)
            if !n.isFinite || n < 0 { return "auto" }
            return round(Swift.min(2, n), digits: 2)
        }
        return "auto"
    }

    private func normalizeProofread(_ raw: Any?) -> [String: Any] {
        let o = asMap(raw)
        let s = (o["sessionId"] as? String)?.trimmingJava() ?? ""
        let valid = Self.sessionPattern.hasMatch(s) ? s : ""
        return ["sessionId": valid]
    }

    private func normalizeWritingPrefs(_ raw: [String: Any]?) -> [String: Any] {
        let goalNumber = raw.map { toDouble($0["dailyGoal"]) } ?? .nan
        let dailyGoal: Int64 = goalNumber.isFinite
            ? Swift.min(100000, Swift.max(0, Int64((goalNumber).rounded())))
            : Self.defaultDailyGoal
        let enabled = raw?["reminderEnabled"]
        let time = raw?["reminderTime"] as? String
        return [
            "dailyGoal": dailyGoal,
            "reminderEnabled": enabled == nil ? true : Self.strictBool(enabled),
            "reminderTime": (time.map { Self.reminderTimePattern.hasMatch($0) } ?? false)
                ? time! : Self.defaultReminderTime
        ]
    }

    private func mergeWritingPrefs(_ prevObj: Any?, _ patchObj: Any?) -> [String: Any] {
        let prev = asMap(prevObj)
        let patch = asMap(patchObj)
        var out = normalizeWritingPrefs(prev)
        if patch["dailyGoal"] != nil {
            let n = toDouble(patch["dailyGoal"])
            if n.isFinite {
                out["dailyGoal"] = Swift.min(100000, Swift.max(0, Int64(n.rounded())))
            }
        }
        if patch["reminderEnabled"] != nil {
            out["reminderEnabled"] = Self.strictBool(patch["reminderEnabled"])
        }
        if let t = patch["reminderTime"] as? String, Self.reminderTimePattern.hasMatch(t) {
            out["reminderTime"] = t
        }
        return out
    }

    private func normalizeIntentList(_ v: Any?) -> [String] {
        if let arr = v as? [Any] {
            var joined = ""
            for o in arr { joined += normalizeIntent(o) + "\n" }
            return parseIntents(joined)
        }
        if let s = v as? String { return parseIntents(s) }
        return []
    }

    private func normalizeIntent(_ v: Any?) -> String {
        // 逐字对齐 Java：replaceAll("[\\r\\n]+", " ")——连续换行折叠成一个空格
        // （不能拆成三次单字符替换，否则 "\r\n\r\n" 会变成两个空格而蓝本是一个）
        let collapsed = Self.stringOf(v).replacingOccurrences(
            of: #"[\r\n]+"#, with: " ", options: .regularExpression)
        let s = collapsed.trimmingJava()
        return s.count > 40 ? String(s.prefix(40)) : s
    }

    private func parseIntents(_ text: String) -> [String] {
        let s = text.count > 2000 ? String(text.prefix(2000)) : text
        var out: [String] = []
        for line in s.components(separatedBy: "\n") {
            let v = normalizeIntent(line)
            if v.isEmpty || out.contains(v) { continue }
            out.append(v)
            if out.count >= 20 { break }
        }
        return out
    }

    // MARK: - 剪枝

    private func pruneDrafts(_ limits: DraftLimits) {
        let dir = dataDir.appendingPathComponent("drafts")
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir,
                                                                   includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasSuffix(".md") }
        if files.isEmpty { return }
        let sorted = files.sorted { mtimeMillis($0) < mtimeMillis($1) }
        var total: Int64 = 0
        for f in sorted {
            total += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        if Int64(sorted.count) <= limits.maxFiles && total <= limits.maxTotalBytes { return }

        var n = sorted.count
        var sum = total
        var over = 0
        while n > 1 && over < sorted.count
                && (Int64(n) > limits.maxFiles || sum > limits.maxTotalBytes) {
            sum -= Int64((try? sorted[over].resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            n -= 1
            over += 1
        }
        for i in 0..<over {
            let old = sorted[i]
            tryDelete(old)
            let jsonPath = old.path.replacingOccurrences(of: ".md$", with: ".json",
                                                         options: .regularExpression)
            tryDelete(URL(fileURLWithPath: jsonPath))
        }
    }

    private func proofPrune() {
        let dir = dataDir.appendingPathComponent("proofread")
        let files = ((try? FileManager.default.contentsOfDirectory(at: dir,
                                                                   includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasSuffix(".json") }
        if files.count <= Self.proofCacheMax { return }
        let sorted = files.sorted { mtimeMillis($0) < mtimeMillis($1) }
        let removeCount = sorted.count - Self.proofCacheMax
        for i in 0..<removeCount { tryDelete(sorted[i]) }
    }

    private func tryDelete(_ f: URL) {
        try? FileManager.default.removeItem(at: f)
    }

    // MARK: - 数值工具

    private func clampLong(_ v: Any?, _ lo: Int64, _ hi: Int64, _ dflt: Int64) -> Int64 {
        let n = toDouble(v)
        guard n.isFinite else { return dflt }
        return Swift.min(hi, Swift.max(lo, Int64(n.rounded())))
    }

    private func clampDouble(_ v: Any?, _ lo: Double, _ hi: Double, _ dflt: Double) -> Double {
        let n = toDouble(v)
        guard n.isFinite else { return dflt }
        return Swift.min(hi, Swift.max(lo, n))
    }

    private func clampFontSize(_ v: Any?) -> Int64 {
        let n = toDouble(v)
        guard n.isFinite, n > 0 else { return 0 }
        return Swift.min(32, Swift.max(10, Int64(n.rounded())))
    }

    private func clampOptionalDouble(_ v: Any?, _ lo: Double, _ hi: Double, digits: Int) -> Double {
        let n = toDouble(v)
        guard n.isFinite, n > 0 else { return 0 }
        return round(Swift.min(hi, Swift.max(lo, n)), digits: digits)
    }

    private func clampOptionalLong(_ v: Any?, _ lo: Int64, _ hi: Int64) -> Int64 {
        let n = toDouble(v)
        guard n.isFinite, n > 0 else { return 0 }
        return Swift.min(hi, Swift.max(lo, Int64(n.rounded())))
    }

    private func toDouble(_ v: Any?) -> Double {
        if let n = v as? NSNumber {
            return CFNumberIsFloatType(n as CFNumber) ? n.doubleValue : Double(n.int64Value)
        }
        if let s = v as? String {
            return Double(s.trimmingJava()) ?? .nan
        }
        return .nan
    }

    private func round(_ n: Double, digits: Int) -> Double {
        let f = pow(10.0, Double(digits))
        return (n * f).rounded() / f
    }

    private static func strictBool(_ v: Any?) -> Bool {
        (v as? Bool) == true
    }

    private static func falseBool(_ v: Any?) -> Bool {
        (v as? Bool) == false
    }

    // MARK: - 基础工具

    private func asMap(_ o: Any?) -> [String: Any] {
        guard let m = o as? [String: Any] else { return [:] }
        return m
    }

    private static func stringOf(_ o: Any?) -> String {
        if let s = o as? String { return s }
        if let o = o { return String(describing: o) }
        return ""
    }

    private func int64(_ o: Any?) -> Int64 {
        (o as? NSNumber)?.int64Value ?? 0
    }

    private func deepCopy(_ m: [String: Any]) -> [String: Any] {
        guard let data = try? JSONSerialization.data(withJSONObject: m, options: [.fragmentsAllowed]),
              let copy = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return m
        }
        return copy
    }

    private func fail(_ error: String) -> [String: Any] {
        ["ok": false, "error": error]
    }

    private func safeRelPath(_ relPath: String) -> Bool {
        if relPath.isEmpty { return false }
        let segs = relPath.replacingOccurrences(of: "\\", with: "/")
            .components(separatedBy: "/")
        return !segs.contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }

    private func clearDraftLocked(_ root: String, _ relPath: String) -> [String: Any] {
        let key = Self.draftKeyFor(root: root, relPath: relPath)
        let dir = dataDir.appendingPathComponent("drafts")
        var cleared: Int64 = 0
        for name in [key + ".md", key + ".json"] {
            let f = dir.appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: f.path) {
                do { try FileManager.default.removeItem(at: f); cleared += 1 } catch { }
            }
        }
        return ["ok": true, "cleared": cleared]
    }

    // MARK: - 配置 IO

    private func readConfig() -> [String: Any] {
        let f = dataDir.appendingPathComponent("config.json")
        if let text = try? readText(f),
           let parsed = try? jsonParse(text),
           let m = parsed as? [String: Any] {
            return m
        }
        return [:]
    }

    private func writeConfig(_ cfg: [String: Any]) throws {
        let f = dataDir.appendingPathComponent("config.json")
        try mkdirs(f.deletingLastPathComponent())
        try writeWhole(f, text: try jsonStringify(cfg))
    }

    // MARK: - JSON / IO

    private func jsonParse(_ text: String) throws -> Any {
        let data = Data(text.utf8)
        let obj = try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        return obj
    }

    private func jsonStringify(_ v: Any) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])
        return String(decoding: data, as: UTF8.self)
    }

    private func mkdirs(_ d: URL) throws {
        if !FileManager.default.fileExists(atPath: d.path) {
            do {
                try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("目录创建失败: \(d.path)")
            }
        }
    }

    private func writeWhole(_ f: URL, text: String) throws {
        try atomicWrite(f, Data(text.utf8))
    }

    private func atomicWrite(_ target: URL, _ bytes: Data) throws {
        try mkdirs(target.deletingLastPathComponent())
        tmpSeq += 1
        let tmp = target.deletingLastPathComponent()
            .appendingPathComponent(target.lastPathComponent + ".tmp-\(tmpSeq)")
        do {
            try bytes.write(to: tmp, options: .atomic)
            if FileManager.default.fileExists(atPath: target.path) {
                try FileManager.default.removeItem(at: target)
            }
            try FileManager.default.moveItem(at: tmp, to: target)
        } catch {
            do {
                try bytes.write(to: target, options: .atomic)
                try? FileManager.default.removeItem(at: tmp)
            } catch {
                throw PathGuard.bad("写入失败: \(error.localizedDescription)")
            }
        }
    }

    private func readText(_ f: URL) throws -> String {
        let raw: Data
        do {
            raw = try Data(contentsOf: f)
        } catch {
            throw PathGuard.bad("读取失败: \(error.localizedDescription)")
        }
        var s = String(decoding: raw, as: UTF8.self)
        if s.first == "\u{FEFF}" { s.removeFirst() }
        return s
    }

    private func mtimeMillis(_ u: URL) -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: u.path),
              let date = attrs[.modificationDate] as? Date else { return 0 }
        return Int64((date.timeIntervalSince1970 * 1000).rounded())
    }

    private func nowMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

private extension String {
    func trimmingJava() -> String {
        var scalars = Substring(self).unicodeScalars
        while let first = scalars.first, first.value <= 0x20 { scalars.removeFirst() }
        while let last = scalars.last, last.value <= 0x20 { scalars.removeLast() }
        return String(scalars)
    }
}

private extension NSRegularExpression {
    func hasMatch(_ s: String) -> Bool {
        firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }
}
