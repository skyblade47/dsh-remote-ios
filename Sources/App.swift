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
    /// 设置弹层保存了新网关 ⇒ 壳需以新 origin 重建（baseURL 只能在 loadHTMLString 时定下）。
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
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @StateObject private var session = ShellSession()
    @Environment(\.scenePhase) private var scenePhase

    @State private var shellToken = 0
    @State private var titleTaps = 0
    @State private var showS1 = false
    @State private var showS1Alert = false

    var body: some View {
        VStack(spacing: 0) {
            Text("DSH Remote")
                .font(.headline)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .onTapGesture {
                    titleTaps += 1
                    if titleTaps >= 5 {
                        if (try? GatewayURL.normalize(Cfg.gateway)) != nil {
                            showS1 = true
                            titleTaps = 0
                        } else {
                            showS1Alert = true
                        }
                    }
                }

            Divider()

            // 本地壳永远创建：未配网关走占位 origin，本地写作页离线可用；
            // .id 随 shellToken 变化，使网关变更后以新 origin 重建（换 baseURL/Cookie 同源）。
            // 网关配置入口在壳内「⚙ 设置 → 远程 → 网关地址」（saveConfig 钩子见 App init）。
            ShellWebView(session: session, gatewayRaw: Cfg.gateway)
                .id(shellToken)
                .ignoresSafeArea(edges: .bottom)
        }
        .onChange(of: scenePhase) { _, phase in
            // iOS 切后台不触发 pagehide；主动驱动 writing.js 的 session-end 同步落盘
            if phase == .background { session.flusher.flush() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .dshGatewayChanged)) { _ in
            shellToken += 1
        }
        .alert("请先填写 https 网关", isPresented: $showS1Alert) {
            Button("好", role: .cancel) {}
        } message: {
            Text("请先在「⚙ 设置 → 远程 → 网关地址」填写已开启 HTTPS 的网关地址。")
        }
        .sheet(isPresented: $showS1) {
            UIViewControllerBridge {
                S1ViewController(gatewayOrigin: (try? GatewayURL.normalize(Cfg.gateway)) ?? "")
            }
        }
    }
}

struct UIViewControllerBridge<ViewController: UIViewController>: UIViewControllerRepresentable {
    let make: () -> ViewController

    func makeUIViewController(context: Context) -> ViewController { make() }

    func updateUIViewController(_ uiViewController: ViewController, context: Context) {}
}
