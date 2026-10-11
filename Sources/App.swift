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
    /// 网关基址（如 `http://100.64.0.1:8080` —— 走 tailnet 明文；或 Funnel 的 https 域名）
    static var gateway: String {
        get { UserDefaults.standard.string(forKey: "gateway") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "gateway") }
    }
}

/// 跨 SwiftUI 视图边界共享的壳会话：让 RootView 的 scenePhase 事件够到
/// ShellWebView.Coordinator 持有的 WKWebView（Coordinator 由 representable 私有创建）。
final class ShellSession: ObservableObject {
    let flusher = BackgroundFlusher(live: ())
}

@main
struct DSHRemoteApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

struct RootView: View {
    @StateObject private var session = ShellSession()
    @Environment(\.scenePhase) private var scenePhase

    @State private var urlText: String = Cfg.gateway
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

            // 临时网关条（增量 2 会被原生设置页的「网关连接」分区取代）：
            // 未配置时也不挡本地写作页 —— 壳永远直达，仅 [DSH] 对话需要网关。
            HStack {
                TextField("网关 https 地址，例如 https://<xxx>.ts.net", text: $urlText)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button("连接") {
                    Cfg.gateway = urlText.trimmingCharacters(in: .whitespaces)
                    // baseURL 只能在 loadHTMLString 时定下；改网关 ⇒ 以新 origin 重建壳视图。
                    shellToken += 1
                }
                .buttonStyle(.borderedProminent)
                .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(8)

            Divider()

            // 本地壳永远创建：未配网关走占位 origin，本地写作页离线可用；
            // .id 随 shellToken 变化，使「连接」后以网关 origin 重建（换 baseURL/Cookie 同源）。
            ShellWebView(session: session, gatewayRaw: Cfg.gateway)
                .id(shellToken)
                .ignoresSafeArea(edges: .bottom)
        }
        .onChange(of: scenePhase) { _, phase in
            // iOS 切后台不触发 pagehide；主动驱动 writing.js 的 session-end 同步落盘
            if phase == .background { session.flusher.flush() }
        }
        .alert("请先填写 https 网关", isPresented: $showS1Alert) {
            Button("好", role: .cancel) {}
        } message: {
            Text("先在上方填写已开启 HTTPS 的网关地址并点「连接」。")
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
