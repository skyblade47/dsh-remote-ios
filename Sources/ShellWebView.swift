import SwiftUI
import WebKit

// ============================================================================
// WKWebView 封装 —— 本仓的**核心**（其余多为脚手架）
//
// 承载三件与安卓壳对应的事：
//   ① 「回环权威门」：页面脚本执行前（atDocumentStart，主框架+同源 iframe）注入 BridgeJS，
//      其中含 globalThis.__DSH_TRANSPORT__ = { ownsHost: true } 与 wcStorage/wcWriting 桥。
//   ② 本地资产：dsh-asset://local/<name> 由 ShellSchemeHandler 从 Bundle 应答（Task 4 的
//      /__shell__/ 导航接管负责把主壳换成本地 HTML）。
//   ③ wcStorage 消息桥：window.webkit.messageHandlers.dshBridge → NativeBridge →
//      BridgeDispatcher（Documents 沙盒）；同步 *Sync 通道由 Task 10 的 dsh-bridge handler 承接。
//
// 本地应答路线：WKURLSchemeHandler 不能拦 http/https，故主框架 /__shell__/ 经
// decidePolicyFor 取消 + loadHTMLString(baseURL:网关) 虚拟同源；本地资产走自定义
// dsh-asset://（见 ShellSchemeHandler）。iframe 与 /api 等保持直连网关。
// ============================================================================

struct ShellWebView: UIViewRepresentable {
    let session: ShellSession
    let urlString: String

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        // 与 PC 客户端同口径：Cookie 走默认存储（同一 app 内持久）
        cfg.websiteDataStore = .default()

        // ② 本地壳资产（shell.html 改写后外链 dsh-asset://local/<name>）
        cfg.setURLSchemeHandler(ShellSchemeHandler(loadData: { name in
            guard let url = Bundle.main.url(forResource: name, withExtension: nil) else { return nil }
            return try? Data(contentsOf: url)
        }), forURLScheme: "dsh-asset")

        // ① document-start 注入（早于页面任何脚本；forMainFrameOnly:false 穿透同源 iframe）
        cfg.userContentController.addUserScript(
            WKUserScript(source: BridgeJS.source, injectionTime: .atDocumentStart,
                        forMainFrameOnly: false)
        )

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.customUserAgent = (web.value(forKey: "userAgent") as? String)
            .map { $0 + " DSHRemote/\(Coordinator.appVersion)" }
        // ③ 桥在此创建并注册（早于下面的 web.load）；dispatcher 不可用时 attach 内部空操作
        context.coordinator.attach(to: web)

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

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        // 断开 UCC → handler 强引用（NativeBridge 的 reply 已弱引 webView，这里再破 UCC 一侧）
        web.configuration.userContentController.removeScriptMessageHandler(forName: "dshBridge")
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        weak var web: WKWebView?
        private var bridge: NativeBridge?
        private let dispatcher: BridgeDispatcher?
        private let session: ShellSession

        static let appVersion: String =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"

        init(session: ShellSession) {
            self.session = session
            // spec §6.1：dataDir=Documents 根（config.json/outbox.json/drafts/proofread/sync 直接在根），
            // workspaceRoot=Documents/workspace（英文目录名，对齐安卓 getFilesDir()/workspace）
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let workspaceRoot = docs.appendingPathComponent("workspace", isDirectory: true)
            let made = try? BridgeDispatcher(
                dataDir: docs, workspaceRoot: workspaceRoot, appVersion: Self.appVersion)
            if made == nil {
                NSLog("[dsh-ios] BridgeDispatcher 构造失败，wcStorage 桥未安装（页面走未安装兜底）")
            }
            self.dispatcher = made
            super.init()
        }

        func attach(to web: WKWebView) {
            self.web = web
            // 后台 flush 绑定（无论 dispatcher 是否可用；flushScript 只依赖页面里的 writing.js）
            session.flusher.bind(webView: web)
            guard let dispatcher else { return }
            let bridge = NativeBridge(dispatcher: dispatcher, webView: web)
            self.bridge = bridge
            web.configuration.userContentController.add(bridge, name: "dshBridge")
            // 同步通道（writeDocSync/writeDraftSync），与异步桥共用同一 dispatcher（ioLock 互斥）
            web.configuration.setURLSchemeHandler(
                BridgeSyncSchemeHandler(dispatcher: dispatcher), forURLScheme: "dsh-bridge")
        }

        // MARK: - 导航观测

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

        // MARK: - /__shell__/ 主框架导航接管（Task 4）

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url,
                  ShellNavPolicy.shouldTakeOver(
                    mainFrame: navigationAction.targetFrame?.isMainFrame ?? false, url: url) else {
                decisionHandler(.allow)
                return
            }
            decisionHandler(.cancel)
            Self.loadLocalShell(into: webView, baseURL: url)
        }

        static func loadLocalShell(into webView: WKWebView, baseURL: URL) {
            guard let u = Bundle.main.url(forResource: "shell", withExtension: "html"),
                  let raw = try? String(contentsOf: u, encoding: .utf8),
                  let rewritten = try? ShellHTMLRewriter.rewrite(raw) else {
                NSLog("[DSH] 本地壳读取/改写失败，回退网络加载")
                webView.load(URLRequest(url: baseURL))
                return
            }
            webView.loadHTMLString(rewritten, baseURL: baseURL)
        }
    }
}

enum ShellNavPolicy {
    static func shouldTakeOver(mainFrame: Bool, url: URL) -> Bool {
        guard mainFrame else { return false }
        guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        return c.path.hasPrefix("/__shell__/")
    }
}
