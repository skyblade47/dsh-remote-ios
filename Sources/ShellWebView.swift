import SwiftUI
import WebKit

// ============================================================================
// WKWebView 封装 —— 本仓的**核心**（其余多为脚手架）
//
// 承载三件与安卓壳对应的事：
//   ① 「回环权威门」：页面脚本执行前（atDocumentStart，主框架+同源 iframe）注入 BridgeJS，
//      其中含 globalThis.__DSH_TRANSPORT__ = { ownsHost: true } 与 wcStorage/wcWriting 桥。
//   ② 本地壳资产：主壳 shell.html 永远从 Bundle 经 loadHTMLString **直达**（零网络首发），
//      其外链 dsh-asset://local/<name> 由 ShellSchemeHandler 从 Bundle 应答。
//   ③ wcStorage 消息桥：window.webkit.messageHandlers.dshBridge → NativeBridge →
//      BridgeDispatcher（Documents 沙盒）；同步 *Sync 通道由 Task 10 的 dsh-bridge handler 承接。
//
// 本地优先路线（替代旧的「先联网 /__shell__/shell.html 再 decidePolicyFor 取消换壳」）：
//   WKURLSchemeHandler 不能拦 http/https，故主壳不发任何网络请求，直接 loadHTMLString；
//   文档 origin 由 baseURL 决定 —— 已配网关借网关 origin（壳内同源 /app#/ 过网关
//   frame-ancestors 'self'、Cookie 同源），未配置则用 ShellOrigin.placeholder 占位，
//   本地写作页离线可用（见 ShellOrigin）。配置变更时由 App 侧用 .id 重建本视图。
// ============================================================================

struct ShellWebView: UIViewRepresentable {
    let session: ShellSession
    /// 用户配置的网关原文（可能为空/非法）；origin 解析交给 ShellOrigin。
    let gatewayRaw: String

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
        // ③ 桥在此创建并注册（早于下面的本地壳加载）；dispatcher 不可用时 attach 内部空操作
        context.coordinator.attach(to: web)

        // 本地壳直达：不发任何网络请求；origin 由 baseURL 决定（网关 origin 或占位 origin）。
        Self.loadLocalShell(into: web, gatewayRaw: gatewayRaw)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        // 配置变更走 App 侧 .id 重建；同一实例生命周期内 gatewayRaw 不变，无需处理。
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        // 断开 UCC → handler 强引用（NativeBridge 的 reply 已弱引 webView，这里再破 UCC 一侧）
        web.configuration.userContentController.removeScriptMessageHandler(forName: "dshBridge")
    }

    /// 从 Bundle 读取 shell.html → ShellHTMLRewriter 改写 → loadHTMLString(baseURL:) 直达。
    /// 资产缺失/改写失败属于安装包损坏类致命错误：记录日志并加载最小错误页，绝不回退网络首发。
    static func loadLocalShell(into webView: WKWebView, gatewayRaw: String) {
        guard let u = Bundle.main.url(forResource: "shell", withExtension: "html"),
              let raw = try? String(contentsOf: u, encoding: .utf8) else {
            NSLog("[dsh-ios] 本地壳 shell.html 读取失败（Bundle 资产缺失）")
            webView.loadHTMLString(Self.fatalPage("本地壳资源缺失"),
                                   baseURL: ShellOrigin.baseURL(gatewayRaw: gatewayRaw))
            return
        }
        do {
            let rewritten = try ShellHTMLRewriter.rewrite(raw)
            webView.loadHTMLString(rewritten, baseURL: ShellOrigin.baseURL(gatewayRaw: gatewayRaw))
        } catch {
            NSLog("[dsh-ios] 本地壳改写失败：\(error.localizedDescription)")
            webView.loadHTMLString(Self.fatalPage("本地壳改写失败：\(error.localizedDescription)"),
                                   baseURL: ShellOrigin.baseURL(gatewayRaw: gatewayRaw))
        }
    }

    private static func fatalPage(_ message: String) -> String {
        // 不依赖任何外部资源的最小内联错误页（数据转义，避免把错误文本当 HTML 注入）
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
        return "<!doctype html><meta charset=\"utf-8\">"
            + "<body style=\"font-family:-apple-system;padding:24px\">"
            + "<h3>DSH Remote 启动失败</h3><p>\(escaped)</p></body>"
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
    }
}
