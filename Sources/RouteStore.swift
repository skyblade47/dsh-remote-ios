import Foundation
import Combine

// ============================================================================
// Phase 6.2 —— 三档通道路由状态（纯客户端决策，不动服务端）。
//
// 三档：①②内嵌节点 localhost 反代（P2P 默认 / DERP 由 tsnet 内部自动兜底，
//       App 不切换、这里也不区分）；③Funnel https 应急直连。
//
// ③档边界（plan 6.2 用户拍板「网关网页前端」）：节点未认证/持续故障且用户手动
// 打开应急开关时，WKWebView 直连用户手输的 Funnel https 地址、加载**网关自己的
// 网页应用**——不套 iPad Bundled 壳、不注入 BridgeJS、不走 dshBridge。本地未上传
// 草稿仍安全留在 outbox；回内嵌主线后自动 drain。
//
// 决策口径：
//   - .running            ⇒ 一律 .embedded（主线一就绪就回内嵌；running 时开应急不抢跳）；
//   - .stopped/.failed    ⇒ 应急开 + Funnel 合法 ⇒ .funnel，否则 nil（WebView 放状态页）；
//   - .starting/.reconnecting ⇒ 维持上一路由（启动中不抢跳；回前台重建只盖浮层不拆壳）。
// 应急开关只响应用户手动，不做基于失败计数的自动降级（防误切）；running 恢复后自动
// 回内嵌是安全方向（北极星：上传同步优先），开关保持开着以便下次故障继续兜底。
// ============================================================================

enum AppRoute: Equatable {
    /// 内嵌主线：localhost 反代 base（无尾斜杠），壳从 base/__shell__/shell.html 装载。
    case embedded(String)
    /// 应急档：用户手输并经 GatewayURL 归一化的 Funnel https origin（直连，不装壳）。
    case funnel(URL)
}

@MainActor
final class RouteStore: ObservableObject {
    /// App 级单例：路由与 TailnetNode 同纪律，生命周期独立于任何页面。
    static let shared = RouteStore()

    /// 当前生效路由；nil 表示无线路（WebView 放等待/失败状态页）。
    @Published private(set) var route: AppRoute?
    /// 用户手动应急开关（仅本进程内存态，杀进程回默认关：冷启动先信内嵌主线）。
    @Published private(set) var emergencyEnabled = false

    /// 已校验归一化的 Funnel origin；未配置/非法为 nil（来源 UserDefaults "gateway"）。
    private var funnelBase: URL?
    /// 是否已配置合法 Funnel（供状态页决定显示「应急连接」还是「去设置」）。
    var funnelReady: Bool { funnelBase != nil }
    /// 最近一次桥状态（网关变更/开关翻转后据此重算，不依赖外部再推一次）。
    private var currentBridge: TailnetNode.BridgeState?

    private weak var node: TailnetNode?
    private let funnelRaw: () -> String
    private var bridgeSink: AnyCancellable?

    /// 生产入口：订阅 TailnetNode 单例桥状态与网关变更通知。
    convenience init() {
        self.init(node: TailnetNode.shared, funnelRaw: { Cfg.gateway })
    }

    /// 注入入口（单测 node 传 nil ⇒ 不订阅单例/通知，桥状态由用例手动 apply）。
    init(node: TailnetNode?, funnelRaw: @escaping () -> String) {
        self.node = node
        self.funnelRaw = funnelRaw
        refreshFunnelURL(notify: false)
        guard let node else { return }

        // @Published 桥状态在主 actor 上变更；闭包非隔离，统一切回主 actor 再 apply。
        bridgeSink = node.$bridge.sink { [weak self] bridge in
            Task { @MainActor in self?.apply(bridge: bridge) }
        }
        // 订阅建立前的当前状态补一拍（保险，不依赖 @Published 的初值回放时序）。
        apply(bridge: node.bridge)

        // 壳内设置弹层保存网关（AppDataStore.onGatewaySaved ⇒ Cfg.gateway ⇒ 此通知）。
        NotificationCenter.default.addObserver(
            forName: .dshGatewayChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshFunnelURL() }
        }
    }

    /// 用户手动开/关应急通道。running 时开不抢跳（running 分支只认内嵌）；
    /// 桥已停/失败且 Funnel 合法时立即降级；关闭则从 funnel 退回状态页。
    func setEmergency(_ on: Bool) {
        emergencyEnabled = on
        recompute()
    }

    /// 重新从 UserDefaults 读 Funnel 地址并归一化（配置变更后调用）。
    func refreshFunnelURL() {
        refreshFunnelURL(notify: true)
    }

    private func refreshFunnelURL(notify: Bool) {
        funnelBase = (try? GatewayURL.normalize(funnelRaw())).flatMap(URL.init(string:))
        if notify { recompute() }
    }

    /// 桥状态驱动（生产由 node.$bridge 订阅触发；测试直接调用）。
    func apply(bridge: TailnetNode.BridgeState) {
        currentBridge = bridge
        switch bridge {
        case .running(let base):
            // 主线就绪：无条件回内嵌（应急开关开着也只等下次故障再兜底）。
            route = .embedded(base)
        case .starting, .reconnecting:
            // 维持上一路由：冷启动入网中不抢跳 funnel；回前台重建不拆已装的壳/应急页。
            break
        case .stopped, .failed:
            if emergencyEnabled, let funnelBase {
                route = .funnel(funnelBase)
            } else {
                route = nil
            }
        }
    }

    private func recompute() {
        guard let currentBridge else { return }
        apply(bridge: currentBridge)
    }
}
