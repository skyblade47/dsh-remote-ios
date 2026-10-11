import Foundation

final class OutboxStore {

    private static let fileName = "outbox.json"

    private let file: URL
    private let lock = NSLock()

    init(dataDir: URL) {
        self.file = dataDir.appendingPathComponent(Self.fileName)
    }

    func add(_ relPath: String?) throws {
        let rel = try normalize(relPath)
        lock.lock()
        defer { lock.unlock() }
        var entries = try read()
        if entries.contains(where: { ($0["relPath"] as? String) == rel }) { return }
        entries.append(["relPath": rel, "queuedAt": nowMillis()])
        try write(entries)
    }

    func remove(_ relPath: String?) {
        guard let relPath = relPath, !relPath.trimmingJava().isEmpty else { return }
        let rel = relPath.replacingOccurrences(of: "\\", with: "/")
        lock.lock()
        defer { lock.unlock() }
        guard var entries = try? read() else { return }
        var changed = false
        for k in stride(from: entries.count - 1, through: 0, by: -1) {
            if (entries[k]["relPath"] as? String) == rel {
                entries.remove(at: k)
                changed = true
            }
        }
        if changed { try? write(entries) }
    }

    func list() -> [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return (try? read()) ?? []
    }

    func count() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return (try? read().count) ?? 0
    }

    func countByDoc() -> [String: Int] {
        lock.lock()
        defer { lock.unlock() }
        var counts: [String: Int] = [:]
        guard let entries = try? read() else { return counts }
        for e in entries {
            let rel = e["relPath"] as? String ?? ""
            guard let slashRange = rel.range(of: "/") else {
                counts["", default: 0] += 1
                continue
            }
            let work = String(rel[rel.startIndex..<slashRange.lowerBound])
            counts[work, default: 0] += 1
        }
        return counts
    }

    // MARK: - 归一化

    private func normalize(_ relPath: String?) throws -> String {
        guard let relPath = relPath else { throw PathGuard.bad("relPath 必须是字符串") }
        let rel = relPath.trimmingJava().replacingOccurrences(of: "\\", with: "/")
        if rel.isEmpty { throw PathGuard.bad("relPath 不得为空") }
        if rel.hasPrefix("/") { throw PathGuard.bad("拒绝绝对路径: \(relPath)") }
        if rel.hasSuffix("/") { throw PathGuard.bad("路径不得以分隔符结尾: \(relPath)") }
        for seg in try PathGuard.splitRel(rel) {
            try PathGuard.validateSegment(seg)
            if seg == "." || seg == ".." {
                throw PathGuard.bad("路径段不得为 . 或 ..: \(relPath)")
            }
        }
        return rel
    }

    // MARK: - 文件读写

    private func read() throws -> [[String: Any]] {
        guard FileManager.default.fileExists(atPath: file.path) else { return [] }
        do {
            let raw = try Data(contentsOf: file)
            var text = String(decoding: raw, as: UTF8.self)
            if text.first == "\u{FEFF}" { text.removeFirst() }
            guard let parsed = try? JSONSerialization.jsonObject(
                with: Data(text.utf8), options: [.fragmentsAllowed]),
                let rawList = parsed as? [Any] else { return [] }
            var out: [[String: Any]] = []
            for o in rawList {
                guard let rawMap = o as? [String: Any],
                      let rel = rawMap["relPath"] as? String,
                      !rel.trimmingJava().isEmpty else { continue }
                let at: Int64
                if let n = rawMap["queuedAt"] as? NSNumber {
                    at = CFNumberIsFloatType(n as CFNumber)
                        ? Int64(n.doubleValue.rounded()) : n.int64Value
                } else {
                    at = 0
                }
                out.append(["relPath": rel, "queuedAt": at])
            }
            out.sort {
                ($0["queuedAt"] as? Int64 ?? 0) < ($1["queuedAt"] as? Int64 ?? 0)
            }
            return out
        } catch {
            return []
        }
    }

    private func write(_ entries: [[String: Any]]) throws {
        let parent = file.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: parent.path) {
            do {
                try FileManager.default.createDirectory(at: parent,
                                                        withIntermediateDirectories: true)
            } catch {
                throw PathGuard.bad("无法创建数据目录: \(parent.path)")
            }
        }
        let json: Data
        do {
            json = try JSONSerialization.data(withJSONObject: entries, options: [.fragmentsAllowed])
        } catch {
            throw PathGuard.bad("写入 outbox 失败: \(error.localizedDescription)")
        }
        let tmp = parent.appendingPathComponent(Self.fileName + ".tmp")
        do {
            try json.write(to: tmp, options: .atomic)
            try move(tmp, file)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw PathGuard.bad("写入 outbox 失败: \(error.localizedDescription)")
        }
    }

    private func move(_ src: URL, _ dst: URL) throws {
        do {
            if FileManager.default.fileExists(atPath: dst.path) {
                try FileManager.default.removeItem(at: dst)
            }
            try FileManager.default.moveItem(at: src, to: dst)
        } catch atomicError {
            do {
                _ = try FileManager.default.replaceItemAt(dst, withItemAt: src)
            } catch {
                throw atomicError
            }
        }
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
