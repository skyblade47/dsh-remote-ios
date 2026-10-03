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

    /// 入口页：默认控制台（`/app#/`）。内核前端 UI 是 `/index.html`。
    static let entryPath = "/app#/"
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
    @State private var urlText: String = Cfg.gateway
    @State private var dropped = false
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

            // 顶部一条窄地址栏：只在"没配/改址"时用，正常使用可折叠
            HStack {
                TextField("网关 https 地址，例如 https://<xxx>.ts.net", text: $urlText)
                    .textFieldStyle(.roundedBorder)
                    .keyboardType(.URL)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button("连接") {
                    Cfg.gateway = urlText.trimmingCharacters(in: .whitespaces)
                    dropped = false
                }
                .buttonStyle(.borderedProminent)
                .disabled(urlText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(8)

            Divider()

            if Cfg.gateway.isEmpty || dropped {
                ContentUnavailableView(
                    "还没有配置网关",
                    systemImage: "network",
                    description: Text("填上面的 https 网关地址后点「连接」。\n免费账号路径不使用 Tailscale，网关需已开启 HTTPS（Funnel）。")
                )
            } else {
                // TODO(P2)：改成 TabView（写作 / DSH 两个 WebView 常驻，切换不重载）
                ShellWebView(urlString: Cfg.gateway + Cfg.entryPath)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .onChange(of: Cfg.gateway) { _, _ in dropped = false }
        .alert("请先填写 https 网关", isPresented: $showS1Alert) {
            Button("好", role: .cancel) {}
        } message: {
            Text("先在上方填写已开启 HTTPS 的网关地址并点「连接」。")
        }
        .sheet(isPresented: $showS1) {
            UIViewControllerBridge {
                S1ViewController(gatewayOrigin: (try? GatewayURL.normalize(Cfg.gateway))?.origin ?? "")
            }
        }
    }
}

struct UIViewControllerBridge<ViewController: UIViewController>: UIViewControllerRepresentable {
    let make: () -> ViewController

    func makeUIViewController(context: Context) -> ViewController { make() }

    func updateUIViewController(_ uiViewController: ViewController, context: Context) {}
}
