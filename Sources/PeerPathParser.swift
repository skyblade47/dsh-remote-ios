import Foundation

// ============================================================================
// Phase 6.2 切片4 —— 网关对端链路形态解析（纯逻辑，不引 TailscaleKit）。
//
// 三档通道的①②档都走内嵌 tsnet，App 不主动切换：DERP(region 900) 由 tsnet 内部
// 自动兜底。UI 只把对端（dsh-cloud 网关，tailnet IPv4 100.99.84.35）当前实际
// 链路形态表现为「直连 P2P / DERP 中继 / 离线 / 未知」，不改变任何路由决策。
//
// 数据来自 TailscaleNode.statusJSON()（Go ipnstate.Status 的标准 JSON）。
// 字段名为 Go 侧 PascalCase，这里用最小 Decodable 子集解析，只取判定需要的键。
// ============================================================================

enum PeerPath: Equatable {
    /// CurAddr 非空：与网关 UDP 直连（①内嵌 P2P 默认档）。
    case p2p(addr: String)
    /// CurAddr 空但 Relay 非空：经 DERP 中继（②自动兜底档，relay 为 region code）。
    case derp(relay: String)
    /// 对端在 tailnet 中标记离线（Online=false）。
    case offline
    /// 对端在线但尚无路径观测（通常刚入网、首包还没建链）。
    case unknown
}

enum PeerPathParser {

    /// 从 statusJSON 数据里按 targetIP 精确匹配 TailscaleIPs，解析该对端链路形态。
    /// - Returns: 对端不存在（无此 IP / Peer 表缺失）返回 nil；JSON 损坏抛错。
    static func parse(_ data: Data, targetIP: String) throws -> PeerPath? {
        let status = try JSONDecoder().decode(StatusEnvelope.self, from: data)
        guard let peers = status.peer?.values else { return nil }
        guard let peer = peers.first(where: { $0.tailscaleIPs?.contains(targetIP) ?? false }) else {
            return nil
        }
        if peer.online == false { return .offline }
        if let cur = peer.curAddr, !cur.isEmpty { return .p2p(addr: cur) }
        if let relay = peer.relay, !relay.isEmpty { return .derp(relay: relay) }
        return .unknown
    }

    // MARK: - Decodable 最小子集（字段名对齐 Go ipnstate）

    private struct StatusEnvelope: Decodable {
        let peer: [String: PeerStatus]?
        enum CodingKeys: String, CodingKey { case peer = "Peer" }
    }

    fileprivate struct PeerStatus: Decodable {
        let tailscaleIPs: [String]?
        let curAddr: String?
        let relay: String?
        let online: Bool?
        enum CodingKeys: String, CodingKey {
            case tailscaleIPs = "TailscaleIPs"
            case curAddr = "CurAddr"
            case relay = "Relay"
            case online = "Online"
        }
    }
}
