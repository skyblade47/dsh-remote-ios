import SwiftUI
@preconcurrency import WebKit
import UIKit

// ============================================================================
// WKWebView 封装 —— 本仓的**核心**（其余多为脚手架）
//
// Phase 5 起壳架构收敛到 localhost：
//   ① 「回环权威门」：页面脚本执行前（atDocumentStart，主框架+同源 iframe）注入 BridgeJS，
//      其中含 globalThis.__DSH_TRANSPORT__ = { ownsHost: true } 与 wcStorage/wcWriting 桥。
//   ② 壳页面不再 loadHTMLString：主壳固定从内嵌节点的 localhost 反代加载
//      http://127.0.0.1:<动态端口>/__shell__/shell.html（HttpBridge 本地应答，
//      18 件资产以普通同源 http 子资源 <script src>/<link href> 服务，
//      业务 API/WebSocket 由反代 tailscale_dial 透传到 100.99.84.35:8080）。
//      桥未就绪期间在 WebView 内放等待/失败状态页（零网络、零 Bundle 改写依赖）。
//   ③ wcStorage 消息桥：window.webkit.messageHandlers.dshBridge → NativeBridge →
//      BridgeDispatcher（Documents 沙盒）；同步 *Sync 通道暂留 dsh-bridge handler，
//      Task 5.6 真机实测 http origin 下自定义 scheme 同步 XHR 是否仍可用后再定去留。
// ============================================================================

struct ShellWebView: UIViewRepresentable {
    let session: ShellSession
    /// 当前 localhost 反代状态（由 App 侧观察 TailnetNode.shared.bridge 后传入）。
    let bridge: TailnetNode.BridgeState

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        // 与 PC 客户端同口径：Cookie 走默认存储（同一 app 内持久）
        cfg.websiteDataStore = .default()

        // document-start 脚本（BridgeJS，含 __DSH_TAILNET__ 信号）不在这里静态添加：
        // WKUserScript 建后固化、无法随反代 base 变化更新，改在每次装壳（running）前
        // 按当前 base 重装（见 apply 内 installBridgeScript）；等待/失败状态页不需要桥。

        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        // 整页橡皮筋：壳文档恒 100% 高、滚动全在内层容器（.w-tree/.w-editor 等），
        // 外层 scrollView 的回弹只会让「整个页面被上下拉动」（用户感知像被浏览器窗口包住）
        // ⇒ 关掉。内层列表的滚动由 WebKit 滚动树处理，不受此开关影响。
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.scrollView.alwaysBounceHorizontal = false
        web.customUserAgent = (web.value(forKey: "userAgent") as? String)
            .map { $0 + " DSHRemote/\(Coordinator.appVersion)" }
        // ③ 桥在此创建并注册（早于壳加载）；dispatcher 不可用时 attach 内部空操作
        context.coordinator.attach(to: web)

        // ② 按桥当前状态装载壳或状态页
        context.coordinator.apply(bridge, to: web)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        // 桥状态变化（starting→running→failed）驱动装载/状态页；壳本身不因网关变化重建。
        context.coordinator.apply(bridge, to: web)
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

        /// 当前已装载的反代 base；壳成功加载后非空，桥重启换端口时随之重载。
        private var loadedBase: String?
        /// 当前展示的状态页标识（nil 表示壳/非状态页）；相同状态不重复 loadHTMLString。
        private var statusShown: String?

        static let appVersion: String =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"

        init(session: ShellSession) {
            self.session = session
            // dataDir=Documents 根（config.json/outbox.json/drafts/proofread/sync 直接在根）。
            // 沙盒多工作区：容器 Documents/workspace，其下每个子目录是一个工作区，
            // 当前工作区名持久化在 config.json 的 currentWorkspace。
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let container = docs.appendingPathComponent("workspace", isDirectory: true)
            let made = try? BridgeDispatcher(
                dataDir: docs, workspaceRoot: container,
                multiWorkspace: true, appVersion: Self.appVersion)
            if made == nil {
                NSLog("[dsh-ios] BridgeDispatcher 构造失败，wcStorage 桥未安装（页面走未安装兜底）")
            }
            self.dispatcher = made
            super.init()
            // 首启迁移：老版本经原生条配的网关在 UserDefaults ⇒ 回填 config.json，
            // 让设置弹层「网关地址」显示当前生效值（config 已有值时不动）。
            made?.seedGatewayFromShellIfNeeded(Cfg.gateway)
        }

        func attach(to web: WKWebView) {
            self.web = web
            // 后台 flush 绑定（无论 dispatcher 是否可用；flushScript 只依赖页面里的 writing.js）
            session.flusher.bind(webView: web)
            guard let dispatcher else { return }
            let bridge = NativeBridge(dispatcher: dispatcher, webView: web)
            self.bridge = bridge
            web.configuration.userContentController.add(bridge, name: "dshBridge")
            // 同步通道（writeDocSync/writeDraftSync），与异步桥共用同一 dispatcher（ioLock 互斥）。
            // 5.6：先真机实测 http loopback origin 下自定义 scheme 同步 XHR 是否可用再定去留。
            web.configuration.setURLSchemeHandler(
                BridgeSyncSchemeHandler(dispatcher: dispatcher), forURLScheme: "dsh-bridge")
        }

        // MARK: - 壳装载（localhost 反代状态机）

        /// 按 TailnetNode.bridge 状态驱动 WebView：
        /// - running(base)：装载反代壳（base 变化即重载，适配桥重启换动态端口）；
        /// - starting/stopped：等待页；
        /// - failed：失败页（引导去右上「TS」设置页入网/重试）。
        /// 节点运行中 bridge 偶发短暂变更时不主动拆已装好的壳，避免无谓白屏；
        /// 只有在尚未装好壳时才放等待/失败状态页。
        func apply(_ state: TailnetNode.BridgeState, to webView: WKWebView) {
            switch state {
            case .running(let base):
                guard loadedBase != base else { return }
                guard let shellURL = URL(string: base)?.appendingPathComponent("/__shell__/shell.html") else {
                    NSLog("[dsh-ios] 反代 base 非法：\(base)")
                    return
                }
                loadedBase = base
                statusShown = nil
                installBridgeScript(state: "running", base: base, reachable: true, in: webView)
                var request = URLRequest(url: shellURL)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                webView.load(request)
            case .starting:
                guard loadedBase == nil else { return }
                showStatus("starting", page: Self.startingPage, in: webView)
            case .stopped:
                guard loadedBase == nil else { return }
                showStatus("stopped", page: Self.stoppedPage, in: webView)
            case .failed(let reason):
                guard loadedBase == nil else { return }
                showStatus("failed", page: Self.failedPage(reason), in: webView)
            }
        }

        /// 装壳前（重新）安装 document-start 桥脚本。WKUserScript 建后不可变，
        /// 桥重启换端口时必须 removeAllUserScripts 后按当前 base 重装，
        /// 否则 __DSH_TAILNET__.base 会指向已失效的旧端口。
        private func installBridgeScript(
            state: String, base: String, reachable: Bool, in webView: WKWebView
        ) {
            let ucc = webView.configuration.userContentController
            ucc.removeAllUserScripts()
            ucc.addUserScript(WKUserScript(
                source: BridgeJS.source(state: state, base: base, reachable: reachable),
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false))
        }

        private func showStatus(_ key: String, page: String, in webView: WKWebView) {
            guard statusShown != key else { return }
            statusShown = key
            // 状态页以 about:blank 为 base：零网络，且不占据 localhost origin。
            webView.loadHTMLString(page, baseURL: URL(string: "about:blank")!)
        }

        // MARK: - 导航观测

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            NSLog("[dsh-ios] didFinish \(webView.url?.absoluteString ?? "-")")
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("[dsh-ios] didFail \(error.localizedDescription)")
            // 壳导航失败（反代已关/端口失效）：清掉已装载标记，下一拍 bridge 状态重入时装载。
            handleShellFailure(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("[dsh-ios] didFailProvisional \(error.localizedDescription)")
            handleShellFailure(error)
        }

        /// 壳加载失败且错误非主动取消时，清空 loadedBase，使后续 running（新端口）能重载；
        /// 桥若仍标记 running，本拍补一张失败页给出可感知反馈（不静默白屏）。
        private func handleShellFailure(_ error: Error) {
            guard loadedBase != nil else { return }
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            loadedBase = nil
            guard let web else { return }
            showStatus("failed", page: Self.failedPage(error.localizedDescription), in: web)
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

        // MARK: - 状态页（零外部资源）

        private static func wrap(body: String) -> String {
            "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\">"
                + "<style>body{font-family:-apple-system,sans-serif;margin:0;padding:32px;"
                + "color:#1c1c1e;display:flex;min-height:80vh;flex-direction:column;"
                + "justify-content:center;align-items:center;text-align:center;gap:14px}"
                + "h3{margin:0;font-size:18px}p{margin:0;color:#6b7280;font-size:14px;line-height:1.6}"
                + ".spin{width:26px;height:26px;border:3px solid #e5e7eb;border-top-color:#3b82f6;"
                + "border-radius:50%;animation:r 0.9s linear infinite}@keyframes r{to{transform:rotate(360deg)}}"
                + "</style><body>\(body)</body>"
        }

        /// 桥启动中：App 冷启动自动入网 + 起反代通常需要数十秒（弱网更久）。
        static let startingPage = wrap(body:
            "<div class=\"spin\"></div><h3>正在连接内网…</h3>"
            + "<p>正在启动安全通道与本地服务，弱网下可能需要约一分钟。</p>")

        /// 桥停止：节点未认证（首启未喂 key）或已登出。
        static let stoppedPage = wrap(body:
            "<h3>内网通道未连接</h3>"
            + "<p>请点右上角「TS」完成一次入网，通道建立后会自动进入写作页。</p>")

        /// 桥失败/壳加载失败：reason 转义后上屏，绝不静默白屏。
        static func failedPage(_ reason: String) -> String {
            let escaped = reason
                .replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
            return wrap(body:
                "<h3>本地通道不可用</h3>"
                + "<p>\(escaped)</p>"
                + "<p>请点右上角「TS」查看节点状态并重试。</p>")
        }

        // MARK: - JS alert/confirm 面板

        // writing.js 有三处 window.confirm（切换工作区前落盘确认 / 回收站彻底删除 /
        // 重启客户端）。WKUIDelegate 不实现 confirm 时 WebKit 默认按「取消」处理，
        // 会把带未保存修改的工作区切换**静默挡掉** ⇒ 必须给原生确认面板。
        func webView(
            _ webView: WKWebView,
            runJavaScriptConfirmPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping (Bool) -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(
                title: "取消", style: .cancel, handler: { _ in completionHandler(false) }))
            alert.addAction(UIAlertAction(
                title: "确定", style: .default, handler: { _ in completionHandler(true) }))
            // 找不到可承载 VC（极端时序）时按「取消」兜底，与 WebKit 默认结论一致。
            presentFromTop(alert) { completionHandler(false) }
        }

        func webView(
            _ webView: WKWebView,
            runJavaScriptAlertPanelWithMessage message: String,
            initiatedByFrame frame: WKFrameInfo,
            completionHandler: @escaping () -> Void
        ) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(
                title: "知道了", style: .default, handler: { _ in completionHandler() }))
            presentFromTop(alert) { completionHandler() }
        }

        /// 取 key window 最上层 VC 承载 JS 面板；取不到时走 fallback，避免 WebKit 回调悬挂。
        private func presentFromTop(_ controller: UIAlertController, fallback: () -> Void) {
            guard var top = Self.topViewController() else { fallback(); return }
            while let presented = top.presentedViewController { top = presented }
            top.present(controller, animated: true)
        }

        static func topViewController(
            base: UIViewController? =
                UIApplication.shared.connectedScenes
                .compactMap({ ($0 as? UIWindowScene)?.keyWindow?.rootViewController })
                .first
        ) -> UIViewController? {
            guard let base else { return nil }
            if let nav = base as? UINavigationController { return topViewController(base: nav.visibleViewController) }
            if let tab = base as? UITabBarController, let sel = tab.selectedViewController {
                return topViewController(base: sel)
            }
            if let presented = base.presentedViewController { return topViewController(base: presented) }
            return base
        }
    }
}
