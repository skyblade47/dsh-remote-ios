import SwiftUI

// ============================================================================
// 入口 + 配置
//
// 🔴 两条纪律：
//   ① **不写死任何个人地址**：网关地址从 UserDefaults 读，首次为空 ⇒ 界面上让用户填
//      （与 `dsh-remote` 里 `mirror-private.json` 同一取向：代码里不带个人字面量）。
//   ② 版本号与主仓同一节奏（`0.1.0`），不擅升。
// ============================================================================

enum Cfg {
    /// 网关基址（如 `https://<xxx>.ts.net` —— Funnel HTTPS；归一化口径见 GatewayURL）
    static var gateway: String {
        get { UserDefaults.standard.string(forKey: "gateway") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "gateway") }
    }
}

extension Notification.Name {
    /// 设置弹层保存了新网关（Funnel 应急地址）。Phase 5 起 localhost 壳 origin 恒定，
    /// 不再据此重建 WebView；通知保留给三档通道（Task 6.2）应急切换使用。
    static let dshGatewayChanged = Notification.Name("dsh.gatewayChanged")
}

/// 跨 SwiftUI 视图边界共享的壳会话：让 RootView 的 scenePhase 事件够到
/// ShellWebView.Coordinator 持有的 WKWebView（Coordinator 由 representable 私有创建）。
final class ShellSession: ObservableObject {
    let flusher = BackgroundFlusher(live: ())
}

@main
struct DSHRemoteApp: App {
    init() {
        // 设置弹层（壳内 Web 侧 saveConfig）保存的网关 ⇒ 归一化后落 UserDefaults 并
        // 通知壳重建。异步发通知：让桥的应答先回 JS，重建在下一拍发生。
        AppDataStore.onGatewaySaved = { raw in
            guard let origin = try? GatewayURL.normalize(raw) else { return }
            Cfg.gateway = origin
            DispatchQueue.main.async {
                NotificationCenter.default.post(name: .dshGatewayChanged, object: nil)
            }
        }

        // Phase 3.2：App 级触碰 tsnet 单例保活（节点生命周期独立于任何页面），
        // 有历史态/Keychain 凭据则冷启动自动恢复，否则停在未认证等 3.3 设置页喂 key。
        // autoStart 本身只做本地探测并 fire-and-forget，up 阻塞全在后端 detached 任务里。
        TailnetNode.shared.autoStart()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @StateObject private var session = ShellSession()
    // Phase 5：壳固定走 localhost 反代，观察节点桥状态驱动装载（只观察、不持有节点）。
    @ObservedObject private var node = TailnetNode.shared
    @Environment(\.scenePhase) private var scenePhase

    @State private var titleTaps = 0
    @State private var showS1 = false
    @State private var showS1Alert = false
    @State private var showTS = false   // Phase 3.3：Tailscale 产品设置页（认证/状态/登出）

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text("DSH Remote")
                    .font(.headline)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        titleTaps += 1
                        if titleTaps >= 5 {
                            if case .running = node.bridge {
                                showS1 = true
                                titleTaps = 0
                            } else {
                                showS1Alert = true
                            }
                        }
                    }
                HStack {
                    Spacer()
                    // Phase 3.3 产品入口：Tailscale 认证/节点状态设置页
                    Button { showTS = true } label: {
                        Text("TS").font(.caption.bold()).padding(.horizontal, 8).padding(.vertical, 3)
                            .overlay(Capsule().stroke(.secondary))
                    }
                    .padding(.trailing, 12)
                }
            }

            Divider()

            // Phase 5：localhost origin 恒定，壳不再因网关配置变化重建；
            // 桥状态（starting/running/failed）由 ShellWebView 内部驱动装载与状态页。
            ShellWebView(session: session, bridge: node.bridge)
                .ignoresSafeArea(edges: .bottom)
        }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background:
                // iOS 切后台不触发 pagehide；主动驱动 writing.js 的 session-end 同步落盘
                session.flusher.flush()
            case .active:
                // 6.1：回前台按 2.6 真机结论主动探活/重建外挂 loopback 桥（节点不重 up）。
                // 节点未 online/桥非 running 时内部 no-op；fire-and-forget，不阻塞 UI。
                Task { await TailnetNode.shared.reconnectAfterForeground() }
            default:
                break
            }
        }
        .alert("内网通道未就绪", isPresented: $showS1Alert) {
            Button("好", role: .cancel) {}
        } message: {
            Text("请先点右上角「TS」完成入网，本地通道就绪后再打开自检。")
        }
        .sheet(isPresented: $showS1) {
            UIViewControllerBridge {
                S1ViewController(loopbackBase: node.bridge.runningBase)
            }
        }
        // Phase 3.3：Tailscale 认证产品设置页（观察 App 级单例，不持有节点）
        .sheet(isPresented: $showTS) {
            TailnetSettingsView()
        }
    }
}

struct UIViewControllerBridge<ViewController: UIViewController>: UIViewControllerRepresentable {
    let make: () -> ViewController

    func makeUIViewController(context: Context) -> ViewController { make() }

    func updateUIViewController(_ uiViewController: ViewController, context: Context) {}
}
