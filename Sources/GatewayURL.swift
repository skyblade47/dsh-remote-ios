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
    static func normalize(_ raw: String) throws -> (origin: String, shell: String) {
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
        let origin = base + path
        return (origin, origin + "/__shell__/shell.html")
    }
}
