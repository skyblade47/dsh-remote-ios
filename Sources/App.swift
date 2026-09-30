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

    var body: some View {
        VStack(spacing: 0) {
            // 顶部一条窄地址栏：只在"没配/改址"时用，正常使用可折叠
            HStack {
                TextField("网关地址，例如 http://<tailnet-ip>:8080", text: $urlText)
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
                    description: Text("填上面的地址后点「连接」。\niPad 上记得先装 Tailscale 并登录同一账号（走 tailnet 线路，免客户端证书）。")
                )
            } else {
                // TODO(P2)：改成 TabView（写作 / DSH 两个 WebView 常驻，切换不重载）
                ShellWebView(urlString: Cfg.gateway + Cfg.entryPath)
                    .ignoresSafeArea(edges: .bottom)
            }
        }
        .onChange(of: Cfg.gateway) { _, _ in dropped = false }
    }
}
