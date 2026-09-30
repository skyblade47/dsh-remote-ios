import SwiftUI
import WebKit

// ============================================================================
// WKWebView 封装 —— 本仓的**核心**（其余多为脚手架）
//
// 这里承载两件与安卓壳对应的事：
//   ① 「回环权威门」的解法：在**页面脚本执行前**注入 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`
//      （对应安卓的 `addDocumentStartJavaScript`；iOS 侧用官方 `WKUserScript`）
//      🔴 iOS 比安卓顺：`forMainFrameOnly: false` 一行即可穿透**同源 iframe**
//         （控制台 `/app#/` 用同源 iframe 嵌内核前端 `/index.html`），且**不受页面 CSP 限制**。
//   ② `window.wcStorage` 的消息桥**占位**：PC 客户端里写作页靠它落盘（preload.js → Electron IPC）；
//      iOS 上要换成 WKScriptMessageHandler（P3 再实现真实落点：iCloud 目录 + 沙盒兜底）。
//
// ⚠️ 已知不可行（别再试）：`WKURLSchemeHandler` **只能注册自定义 scheme**，不能拦截 http/https
//    ⇒ 想"在网关 origin 下返回本地资产"这条路走不通，同源问题只能靠反代或让网关托管资产（见 README §4.2）。
// ============================================================================

struct ShellWebView: UIViewRepresentable {
    let urlString: String

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        // 与 PC 客户端同口径：Cookie 走默认存储（同一 app 内持久）
        cfg.websiteDataStore = .default()

        // ① ownsHost 注入（documentStart ⇒ 早于页面任何脚本）
        let inject = """
        try { globalThis.__DSH_TRANSPORT__ = { ownsHost: true }; } catch (e) {}
        """
        cfg.userContentController.addUserScript(
            WKUserScript(source: inject, injectionTime: .atDocumentStart, forMainFrameOnly: false)
        )

        // ② wcStorage 桥（占位：先只回"未实现"，避免页面静默失败时无从判断）
        cfg.userContentController.add(context.coordinator, name: "wcStorage")

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.customUserAgent = (web.value(forKey: "userAgent") as? String).map { $0 + " DSHRemote/0.1.0" }
        context.coordinator.web = web

        if let u = URL(string: urlString) { web.load(URLRequest(url: u)) }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        // 地址变化时重载（简单处理；P2 再谈"两个 WebView 常驻"）
        if let cur = web.url?.absoluteString.split(separator: "#").first.map(String.init),
           let want = URL(string: urlString),
           cur != "\(want.scheme ?? "")://\(want.host ?? "")\(want.path)" {
            web.load(URLRequest(url: want))
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var web: WKWebView?

        // 观测：把关键导航与失败打到 Xcode/系统日志，便于用 `ios syslog` 抓
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            NSLog("[dsh-ios] didFinish \(webView.url?.absoluteString ?? "-")")
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("[dsh-ios] didFail \(error.localizedDescription)")
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("[dsh-ios] didFailProvisional \(error.localizedDescription)")
        }

        func webView(
            _ webView: WKWebView,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            // 🔴 客户端证书（mTLS）在 WKWebView 上**不可用**（`URLCredential(clientCertificate:)` 在 iOS 无效，
            //    只有证书+私钥已装进系统钥匙串身份时才可能自动响应）⇒ 走 tailnet/Funnel，不要依赖 mTLS。
            NSLog("[dsh-ios] challenge method=\(challenge.protectionSpace.authenticationMethod)")
            completionHandler(.performDefaultHandling, nil)
        }

        // target=_blank / window.open ⇒ 同 WebView 打开（不弹新窗）
        func webView(
            _ webView: WKWebView,
            createWebViewWith configuration: WKWebViewConfiguration,
            for navigationAction: WKNavigationAction,
            windowFeatures: WKWindowFeatures
        ) -> WKWebView? {
            if navigationAction.targetFrame == nil { webView.load(navigationAction.request) }
            return nil
        }

        // ② wcStorage 桥的占位实现
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            NSLog("[dsh-ios] wcStorage <- \(String(describing: message.body))")
            // TODO(P3)：在这里实现 window.wcStorage 的等价面（读/写/列/删 + 草稿兜底）。
            //   落点建议：用户选的 iCloud 目录（UIDocumentPicker + security-scoped bookmark）+ 沙盒兜底。
        }
    }
}
