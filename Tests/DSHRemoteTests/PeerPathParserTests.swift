import XCTest
@testable import DSHRemote

// ============================================================================
// Phase 6.2 切片4 —— PeerPathParser 纯逻辑单测。
//
// tsnet statusJSON() 吐出的是 tailscale ipnstate.Status 的标准 JSON：
//   Peer 表每项含 TailscaleIPs / CurAddr / Relay / Online。
// 判定 dsh-cloud 网关对端（按 tailnet IPv4 精确匹配）的链路形态：
//   CurAddr 非空            → 直连 P2P（①档）
//   CurAddr 空、Relay 非空  → DERP 中继（②档，region 900 由 tsnet 内部兜底）
//   Online=false            → 对端离线
//   其余                    → 未知（尚无观测）
// 不引 TailscaleKit、不碰网络，只喂构造 JSON。
// ============================================================================

@MainActor
final class PeerPathParserTests: XCTestCase {

    private let target = "100.99.84.35"

    private func peerJSON(id: String = "peer1",
                          ips: [String] = ["100.99.84.35"],
                          curAddr: String?? = nil,
                          relay: String?? = nil,
                          online: Bool? = true) -> Data {
        var fields: [String] = [
            "\"ID\":\"\(id)\"",
            "\"HostName\":\"dsh-cloud\"",
            "\"DNSName\":\"dsh-cloud.example.ts.net.\"",
            "\"TailscaleIPs\":[\(ips.map { "\"\($0)\"" }.joined(separator: ","))]"
        ]
        if let curAddr { fields.append("\"CurAddr\":\(curAddr.map { "\"\($0)\"" } ?? "null")") }
        if let relay { fields.append("\"Relay\":\(relay.map { "\"\($0)\"" } ?? "null")") }
        if let online { fields.append("\"Online\":\(online)") }
        let body = """
        {"Peer":{"\(id)":{\(fields.joined(separator: ","))}}
        """
        return Data(body.utf8)
    }

    func testCurAddrNonEmptyMeansP2P() throws {
        let json = peerJSON(curAddr: "203.0.113.5:41641", relay: "sha")
        let path = try PeerPathParser.parse(json, targetIP: target)
        XCTAssertEqual(path, .p2p(addr: "203.0.113.5:41641"))
    }

    func testCurAddrEmptyWithRelayMeansDERP() throws {
        let json = peerJSON(curAddr: .some(nil), relay: "sha")
        let path = try PeerPathParser.parse(json, targetIP: target)
        XCTAssertEqual(path, .derp(relay: "sha"))
    }

    func testRelayMissingMeansUnknownWhenOnline() throws {
        let json = peerJSON(curAddr: .some(nil), relay: .some(nil), online: true)
        let path = try PeerPathParser.parse(json, targetIP: target)
        XCTAssertEqual(path, .unknown)
    }

    func testOnlineFalseMeansOffline() throws {
        let json = peerJSON(curAddr: .some(nil), relay: "sha", online: false)
        let path = try PeerPathParser.parse(json, targetIP: target)
        XCTAssertEqual(path, .offline)
    }

    func testOnlineFieldAbsentAndNoPathMeansUnknown() throws {
        let json = peerJSON(curAddr: .some(nil), relay: .some(nil), online: nil)
        let path = try PeerPathParser.parse(json, targetIP: target)
        XCTAssertEqual(path, .unknown)
    }

    func testMatchesByIPv4AmongMultiplePeers() throws {
        let body = """
        {"Peer":{
          "a":{"ID":"a","HostName":"other","TailscaleIPs":["100.64.0.2"],"Relay":"tok","Online":true},
          "b":{"ID":"b","HostName":"dsh-cloud","TailscaleIPs":["100.99.84.35","fd7a::1"],"CurAddr":"198.51.100.7:41641","Online":true}
        }}
        """
        let path = try PeerPathParser.parse(Data(body.utf8), targetIP: target)
        XCTAssertEqual(path, .p2p(addr: "198.51.100.7:41641"))
    }

    func testTargetIPAbsentReturnsNil() throws {
        let json = peerJSON(ips: ["100.64.0.99"], relay: "sha")
        let path = try PeerPathParser.parse(json, targetIP: target)
        XCTAssertNil(path)
    }

    func testPeerMapMissingReturnsNil() throws {
        let path = try PeerPathParser.parse(Data("{}".utf8), targetIP: target)
        XCTAssertNil(path)
    }

    func testPeerNullReturnsNil() throws {
        let path = try PeerPathParser.parse(Data("{\"Peer\":null}".utf8), targetIP: target)
        XCTAssertNil(path)
    }

    func testMalformedJSONThrows() {
        XCTAssertThrowsError(try PeerPathParser.parse(Data("not-json".utf8), targetIP: target))
    }
}
