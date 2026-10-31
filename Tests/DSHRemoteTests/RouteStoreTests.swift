import XCTest
@testable import DSHRemote

// ============================================================================
// Phase 6.2 —— 三档通道路由决策单测（不碰 WebView / 不引网络）。
//
// 三档：①②内嵌节点 localhost 反代（P2P / DERP 由 tsnet 内部兜底，App 不区分）；
//       ③Funnel https 直连网关自己的网页应用（应急，不套 Bundled 壳）。
//
// 决策口径（见 plan 6.2 / spec 2026-10-22 L200、L211）：
//   - bridge .running            ⇒ 一律 .embedded（主线一就绪就回内嵌，哪怕应急开关开着）；
//   - bridge .stopped/.failed    ⇒ 应急开关开 + Funnel 已合法配置 ⇒ .funnel，否则 nil（状态页）；
//   - bridge .starting/.reconnecting ⇒ 维持当前路由（启动中不抢跳；回前台重建只盖浮层不拆壳）。
// 应急开关不做自动降级（防误切），只响应用户手动；running 恢复后自动回内嵌是安全方向。
// ============================================================================

@MainActor
final class RouteStoreTests: XCTestCase {
    /// 测试入口：node 传 nil ⇒ 不订阅 TailnetNode 单例/通知，bridge 由用例手动 apply。
    private func makeStore(_ raw: String = "") -> RouteStore {
        RouteStore(node: nil, funnelRaw: { raw })
    }

    func testInitialStateIsNilRouteAndEmergencyOff() {
        let store = makeStore()
        XCTAssertNil(store.route)
        XCTAssertFalse(store.emergencyEnabled)
    }

    func testRunningProducesEmbeddedWithoutEmergency() {
        let store = makeStore()
        store.apply(bridge: .running("http://127.0.0.1:8080"))
        XCTAssertEqual(store.route, .embedded("http://127.0.0.1:8080"))
    }

    func testStoppedWithoutEmergencyStaysNil() {
        let store = makeStore("https://x.ts.net")
        store.apply(bridge: .stopped)
        XCTAssertNil(store.route)
    }

    func testStoppedWithEmergencyAndConfiguredFunnelUsesFunnel() throws {
        let store = makeStore("https://x.ts.net/")
        store.setEmergency(true)
        store.apply(bridge: .stopped)
        XCTAssertEqual(store.route, .funnel(try XCTUnwrap(URL(string: "https://x.ts.net"))))
    }

    func testFailedWithEmergencyDropsToFunnel() {
        let store = makeStore("https://x.ts.net/gw")
        store.setEmergency(true)
        store.apply(bridge: .failed("boom"))
        XCTAssertEqual(store.route, .funnel(URL(string: "https://x.ts.net/gw")!))
    }

    func testUnauthenticatedStoppedEmergencyWithoutFunnelStaysNil() {
        let store = makeStore("")
        store.setEmergency(true)
        store.apply(bridge: .stopped)
        XCTAssertNil(store.route)
    }

    func testEmergencyWithNonHttpsFunnelRejectedStaysNil() {
        let store = makeStore("http://x.ts.net")
        store.setEmergency(true)
        store.apply(bridge: .failed("boom"))
        XCTAssertNil(store.route)
    }

    func testEmergencyEnabledWhileRunningStaysEmbeddedThenStoppedDropsToFunnel() {
        let store = makeStore("https://x.ts.net")
        store.apply(bridge: .running("http://127.0.0.1:9"))
        store.setEmergency(true)
        // running 时开应急：不抢跳（主线可用就不该降级）。
        XCTAssertEqual(store.route, .embedded("http://127.0.0.1:9"))
        // 桥随后停了（节点故障/登出）⇒ 立刻按已开的应急开关降级。
        store.apply(bridge: .stopped)
        XCTAssertEqual(store.route, .funnel(URL(string: "https://x.ts.net")!))
    }

    func testFunnelAutoReturnsToEmbeddedWhenBridgeRecovers() {
        let store = makeStore("https://x.ts.net")
        store.setEmergency(true)
        store.apply(bridge: .failed("down"))
        XCTAssertEqual(store.route, .funnel(URL(string: "https://x.ts.net")!))
        // 节点恢复、桥重新 running ⇒ 自动回内嵌；应急开关保持开着，下次故障还会兜底。
        store.apply(bridge: .running("http://127.0.0.1:10"))
        XCTAssertEqual(store.route, .embedded("http://127.0.0.1:10"))
        XCTAssertTrue(store.emergencyEnabled)
    }

    func testTurnEmergencyOffWhileDownReturnsToStatusPage() {
        let store = makeStore("https://x.ts.net")
        store.setEmergency(true)
        store.apply(bridge: .failed("down"))
        XCTAssertNotNil(store.route)
        store.setEmergency(false)
        XCTAssertNil(store.route)
    }

    func testReconnectingPreservesCurrentRoute() {
        let store = makeStore()
        // 已装内嵌壳：回前台重建只盖浮层，路由不许变（更不能跳 funnel）。
        store.apply(bridge: .running("http://127.0.0.1:9"))
        store.apply(bridge: .reconnecting)
        XCTAssertEqual(store.route, .embedded("http://127.0.0.1:9"))
        // 冷启动极端时序：reconnecting 时本来就没装任何东西 ⇒ 仍 nil。
        let cold = makeStore()
        cold.apply(bridge: .reconnecting)
        XCTAssertNil(cold.route)
    }

    func testStartingPreservesCurrentRoute() {
        let store = makeStore("https://x.ts.net")
        store.setEmergency(true)
        store.apply(bridge: .stopped)
        XCTAssertEqual(store.route, .funnel(URL(string: "https://x.ts.net")!))
        // 用户在应急档点了重试入网，桥进入 starting：应急页继续展示，不白屏跳状态页。
        store.apply(bridge: .starting)
        XCTAssertEqual(store.route, .funnel(URL(string: "https://x.ts.net")!))
    }

    func testGatewayChangedRefreshesFunnelTarget() {
        var raw = ""
        let store = RouteStore(node: nil, funnelRaw: { raw })
        store.setEmergency(true)
        store.apply(bridge: .stopped)
        XCTAssertNil(store.route)
        // 用户在设置里新填（或壳弹层回写）了合法 Funnel 地址。
        raw = "https://new.example.com:8443"
        store.refreshFunnelURL()
        XCTAssertEqual(store.route, .funnel(URL(string: "https://new.example.com:8443")!))
    }
}
