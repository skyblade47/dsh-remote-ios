import Foundation

enum GatewayURLError: LocalizedError {
    case empty, badScheme, badURL, noHost
    var errorDescription: String? {
        switch self {
        case .empty: return "网关地址为空"
        case .badScheme: return "免费账号路径仅支持 https 网关"
        case .badURL: return "网关地址不是合法 URL"
        case .noHost: return "网关地址缺少主机名"
        }
    }
}

enum GatewayURL {
    /// 校验并归一化**用户手输的应急 Funnel 网关**（三档通道的线路③），返回其 origin
    /// （无尾斜杠；保留可能的子路径前缀与端口）。
    ///
    /// Phase 5 契约：壳的主线 base 固定为内嵌节点的 localhost 反代
    /// `http://127.0.0.1:<动态端口>`，由 TailnetNode/LoopbackProxy 程序生成，
    /// **不是用户输入、不经本函数**。本函数只校验 Funnel 应急地址，故仍强制 https。
    static func normalize(_ raw: String) throws -> String {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw GatewayURLError.empty }
        guard let url = URL(string: text), let comps = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { throw GatewayURLError.badURL }
        guard comps.scheme?.lowercased() == "https" else { throw GatewayURLError.badScheme }
        guard let host = comps.host, !host.isEmpty else { throw GatewayURLError.noHost }

        var base = "\(comps.scheme!)://\(host)"
        if let port = comps.port { base += ":\(port)" }
        let path = comps.path.hasSuffix("/")
            ? String(comps.path.dropLast())
            : comps.path
        return base + path
    }
}
