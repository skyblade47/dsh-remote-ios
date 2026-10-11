import Foundation

enum PathGuardError: LocalizedError {
    case bad(String)

    var errorDescription: String? {
        switch self {
        case .bad(let msg): return msg
        }
    }
}

enum PathGuard {
    static let trashDir = "_回收"
    static let workTrashSub = "_作品"
    static let maxSegment = 120

    private static let forbiddenChars = try! NSRegularExpression(
        pattern: "[\\\\/:*?\"<>|\u{00}-\u{1f}]")
    private static let reservedNames = try! NSRegularExpression(
        pattern: "^(con|prn|aux|nul|com[1-9]|lpt[1-9])$",
        options: [.caseInsensitive])
    private static let mdExt = try! NSRegularExpression(
        pattern: "\\.md$", options: [.caseInsensitive])
    private static let tsSuffix = try! NSRegularExpression(pattern: "-\\d{8}-\\d{6}$")
    private static let lastExt = try! NSRegularExpression(pattern: "\\.[^.]*$")
    private static let drivePrefix = try! NSRegularExpression(pattern: "^[a-zA-Z]:.*")

    static func bad(_ msg: String) -> PathGuardError { .bad(msg) }

    @discardableResult
    static func validateSegment(_ seg: String?) throws -> String {
        guard let seg = seg else { throw bad("名称必须是字符串") }
        if seg.isEmpty { throw bad("名称不得为空") }
        if seg == "." || seg == ".." {
            throw bad("拒绝：路径段不得为 \".\" 或 \"..\"（疑似路径逃逸）: \(seg)")
        }
        if forbiddenChars.hasMatch(seg) {
            throw bad("名称含禁用字符（/ \\ : * ? \" < > | 及控制字符）: \(seg)")
        }
        if seg != javaTrim(seg) { throw bad("名称首尾不得有空白: \(quote(seg))") }
        if seg.hasSuffix(".") || seg.hasSuffix(" ") {
            throw bad("名称不得以点或空格结尾: \(quote(seg))")
        }
        if seg.utf16.count > maxSegment {
            throw bad("名称过长（> \(maxSegment) 字符）: \(seg)")
        }
        let stem = lastExt.replaceAll(in: seg)
        if reservedNames.hasMatch(seg) || reservedNames.hasMatch(stem) {
            throw bad("名称是 Windows 保留设备名: \(seg)")
        }
        return seg
    }

    static func splitRel(_ relPath: String?) throws -> [String] {
        guard let relPath = relPath, !relPath.isEmpty else { throw bad("路径为空") }
        if relPath.hasPrefix("/") || relPath.hasPrefix("\\") {
            throw bad("拒绝绝对路径: \(relPath)")
        }
        if drivePrefix.hasMatch(relPath) { throw bad("拒绝盘符路径: \(relPath)") }
        let segs = relPath.replacingOccurrences(of: "\\", with: "/")
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        if segs.isEmpty { throw bad("路径为空: \(relPath)") }
        return segs
    }

    static func hasMdExt(_ name: String?) -> Bool {
        guard let name = name else { return false }
        return mdExt.hasMatch(name)
    }

    @discardableResult
    static func assertMd(_ relPath: String) throws -> String {
        let segs = try splitRel(relPath)
        let last = segs[segs.count - 1]
        guard hasMdExt(last) else { throw bad("只允许 .md 文件: \(last)") }
        return last
    }

    static func ensureMd(_ name: String?) -> String {
        let n = name ?? ""
        return hasMdExt(n) ? n : n + ".md"
    }

    static func trashStamp(year: Int, month: Int, day: Int,
                           hour: Int, minute: Int, second: Int) -> String {
        pad4(year) + pad2(month) + pad2(day) + "-"
            + pad2(hour) + pad2(minute) + pad2(second)
    }

    static func trashStampNow(date: Date = Date()) -> String {
        let c = Calendar(identifier: .gregorian)
        let v = c.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        return trashStamp(year: v.year ?? 1970, month: v.month ?? 1, day: v.day ?? 1,
                          hour: v.hour ?? 0, minute: v.minute ?? 0, second: v.second ?? 0)
    }

    static func stripTrashStamp(_ s: String) -> String {
        tsSuffix.replaceAll(in: s)
    }

    @discardableResult
    static func resolveInRoot(root: URL, relPath: String) throws -> URL {
        let canonicalRoot = root.standardizedFileURL.resolvingSymlinksInPath()
        let segs = try splitRel(relPath)
        var cur = canonicalRoot
        for seg in segs {
            try validateSegment(seg)
            cur.appendPathComponent(seg)
        }
        let real = realpathDeep(cur)
        let c = real.path
        let r = canonicalRoot.path
        let inside = c == r || c.hasPrefix(r + "/")
        if !inside {
            throw bad("拒绝：路径越界。输入=\(relPath) 解析后=\(c) 不在根 \(r) 之内")
        }
        if c == r { throw bad("拒绝：路径指向根目录本身: \(relPath)") }
        return real
    }

    static func realpathDeep(_ p: URL) -> URL {
        var cur = p.standardizedFileURL
        var tail: [String] = []
        while !FileManager.default.fileExists(atPath: cur.path) {
            let parent = cur.deletingLastPathComponent()
            if parent.path == cur.path { break }
            tail.insert(cur.lastPathComponent, at: 0)
            cur = parent
        }
        let real = cur.resolvingSymlinksInPath()
        return tail.reduce(real) { $0.appendingPathComponent($1) }
    }

    static func uniquePath(_ abs: URL, isDir: Bool) throws -> URL {
        if !FileManager.default.fileExists(atPath: abs.path) { return abs }
        let dir = abs.deletingLastPathComponent()
        let name = abs.lastPathComponent
        let stem: String
        let ext: String
        if isDir {
            stem = name
            ext = ""
        } else if let m = lastExt.firstMatch(in: name), m.range.location > 0 {
            let dot = name.index(name.startIndex, offsetBy: m.range.location)
            stem = String(name[name.startIndex..<dot])
            ext = String(name[dot...])
        } else {
            stem = name
            ext = ""
        }
        for k in 2..<1000 {
            let cand = dir.appendingPathComponent("\(stem)-\(k)\(ext)")
            if !FileManager.default.fileExists(atPath: cand.path) { return cand }
        }
        throw bad("目标重名过多，无法落位: \(abs.path)")
    }

    static func javaTrim(_ s: String) -> String {
        var scalars = s.unicodeScalars
        while let first = scalars.first, first.value <= 0x20 { scalars.removeFirst() }
        while let last = scalars.last, last.value <= 0x20 { scalars.removeLast() }
        return String(scalars)
    }

    static func quote(_ s: String) -> String {
        var out = "\""
        for ch in s {
            if ch == "\"" || ch == "\\" { out.append("\\") }
            out.append(ch)
        }
        out.append("\"")
        return out
    }

    private static func pad2(_ n: Int) -> String { String(format: "%02d", n) }
    private static func pad4(_ n: Int) -> String { String(format: "%04d", n) }
}

private extension NSRegularExpression {
    func hasMatch(_ s: String) -> Bool {
        firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    func firstMatch(in s: String) -> NSTextCheckingResult? {
        firstMatch(in: s, range: NSRange(s.startIndex..., in: s))
    }

    func replaceAll(in s: String, template: String = "") -> String {
        stringByReplacingMatches(in: s,
                                 range: NSRange(s.startIndex..., in: s),
                                 withTemplate: template)
    }
}
