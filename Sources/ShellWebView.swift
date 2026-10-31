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
    /// 6.2 三档通道路由：.embedded 装 localhost 壳 / .funnel 直连网关网页 / nil 放状态页。
    let route: AppRoute?
    /// 是否已配置合法 Funnel 地址（决定 stopped/failed 状态页能否给「应急连接」按钮）。
    let funnelReady: Bool

    func makeCoordinator() -> Coordinator {
        Coordinator(session: session,
                    useEmergency: { Task { @MainActor in RouteStore.shared.setEmergency(true) } },
                    exitEmergency: { Task { @MainActor in RouteStore.shared.setEmergency(false) } },
                    openSettings: {
                        NotificationCenter.default.post(name: .dshOpenTailnetSettings, object: nil)
                    })
    }

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

        // ② 按三档路由装载：内嵌壳 / Funnel 直连页 / 状态页
        context.coordinator.apply(route: route, bridge: bridge, funnelReady: funnelReady, to: web)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        // 路由/桥状态变化驱动装载；同一档内的瞬时状态（reconnecting）不重建页面。
        context.coordinator.apply(route: route, bridge: bridge, funnelReady: funnelReady, to: web)
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

        /// 当前已装载的反代 base；内嵌壳成功加载后非空，桥重启换端口时随之重载。
        private var loadedBase: String?
        /// 6.2 当前已装载的 Funnel origin（应急档）；与 loadedBase 互斥，切档时清空。
        private var loadedFunnel: URL?
        /// 当前展示的状态页标识（nil 表示壳/funnel/非状态页）；相同状态不重复 loadHTMLString。
        private var statusShown: String?
        /// 6.1 回前台重建浮层（盖在壳上，不拆壳）；非重建态置 nil 并移除。
        private var reconnectOverlay: UIView?
        /// 6.2 应急档顶部「返回内网」原生条（只在 funnel 页上盖）。
        private var funnelBanner: UIView?

        /// 状态页「应急连接」按钮回调（由 RouteStore 切应急档）。
        private let useEmergency: () -> Void
        /// 应急条「返回内网」回调。
        private let exitEmergency: () -> Void
        /// 状态页「去设置」回调（未配置 Funnel 时打开 Tailscale 设置页）。
        private let openSettings: () -> Void

        static let appVersion: String =
            Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0"

        init(session: ShellSession,
             useEmergency: @escaping () -> Void,
             exitEmergency: @escaping () -> Void,
             openSettings: @escaping () -> Void) {
            self.session = session
            self.useEmergency = useEmergency
            self.exitEmergency = exitEmergency
            self.openSettings = openSettings
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

        /// 6.2：按三档路由（AppRoute）驱动 WebView，bridge 仅用于同档瞬时状态（重连浮层）。
        /// - .embedded：running 时装 localhost 反代壳（base 变化即重载）；reconnecting 已装壳
        ///   则盖原生「tailnet 重连中」浮层，**不拆壳、不假装在线**；
        /// - .funnel：直连用户手输的 Funnel https origin，**不套壳、不注入 BridgeJS**，
        ///   顶部盖「应急通道·返回内网」原生条；
        /// - nil：等待/未连接/失败状态页（failed 页带「改用 Funnel 应急连接」入口）。
        /// 切档（embedded↔funnel↔nil）才重新装载；同档内的 bridge 瞬时变化不重建页面。
        /// 最近一次 apply 入参：状态页/应急失败页的「重试」按钮据此原地回放（不依赖外部再推）。
        private var lastApply: (route: AppRoute?, bridge: TailnetNode.BridgeState, funnelReady: Bool)?

        func apply(route: AppRoute?, bridge: TailnetNode.BridgeState,
                   funnelReady: Bool, to webView: WKWebView) {
            lastApply = (route, bridge, funnelReady)
            switch route {
            case .embedded(let base):
                applyEmbedded(base: base, bridge: bridge, to: webView)
            case .funnel(let url):
                applyFunnel(url: url, bridge: bridge, to: webView)
            case nil:
                applyStatusOnly(bridge: bridge, funnelReady: funnelReady, to: webView)
            }
        }

        /// ①②内嵌主线：running 装 localhost 壳；reconnecting 只盖浮层；其余状态在已装壳时
        /// 不应出现（路由决策层会把 stopped/failed 切走），保险起见不拆壳。
        private func applyEmbedded(base: String, bridge: TailnetNode.BridgeState, to webView: WKWebView) {
            hideFunnelBanner(in: webView)
            switch bridge {
            case .reconnecting:
                if loadedBase != nil {
                    showReconnectOverlay(in: webView)
                } else {
                    showStatus("reconnecting", page: Self.reconnectingPage, in: webView)
                }
            case .running:
                hideReconnectOverlay()
                guard loadedBase != base else { return }
                guard let shellURL = URL(string: base)?.appendingPathComponent("/__shell__/shell.html") else {
                    NSLog("[dsh-ios] 反代 base 非法：\(base)")
                    return
                }
                // 从应急档切回：先清 funnel 标记，再装 document-start 桥脚本并装载壳。
                loadedFunnel = nil
                loadedBase = base
                statusShown = nil
                installBridgeScript(state: "running", base: base, reachable: true, in: webView)
                var request = URLRequest(url: shellURL)
                request.cachePolicy = .reloadIgnoringLocalCacheData
                webView.load(request)
            default:
                // starting/stopped/failed：壳若已在屏上则保持（路由层正常已切走，不会到这）。
                hideReconnectOverlay()
            }
        }

        /// ③Funnel 应急：直接加载网关自己的网页应用 origin。**不 removeAllUserScripts 之外
        /// 不做任何注入**——切出内嵌时清掉 BridgeJS，保证 funnel 页拿不到 ownsHost/dshBridge。
        private func applyFunnel(url: URL, bridge: TailnetNode.BridgeState, to webView: WKWebView) {
            hideReconnectOverlay()
            // 应急档期间内网节点可能在重试入网（starting），但绝不因此拆应急页/盖内网浮层。
            _ = bridge
            guard loadedFunnel != url else {
                showFunnelBanner(in: webView)
                return
            }
            // 切档：卸下内嵌壳的 document-start 桥脚本与装载标记，状态页标记也清掉。
            webView.configuration.userContentController.removeAllUserScripts()
            loadedBase = nil
            statusShown = nil
            loadedFunnel = url
            var request = URLRequest(url: url)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            webView.load(request)
            showFunnelBanner(in: webView)
        }

        /// 无线路：按 bridge 放等待/状态页。stopped/failed 且已配置 Funnel 时给应急入口。
        private func applyStatusOnly(bridge: TailnetNode.BridgeState,
                                     funnelReady: Bool, to webView: WKWebView) {
            hideReconnectOverlay()
            hideFunnelBanner(in: webView)
            // 从 funnel/壳掉回状态页：清装载标记，保证后续重连能重新装载。
            loadedBase = nil
            loadedFunnel = nil
            // 状态页 key 带 funnelReady：用户在设置页保存/清空 Funnel 后按钮形态要随之刷新。
            let suffix = funnelReady ? ":funnel" : ":none"
            switch bridge {
            case .starting:
                showStatus("starting", page: Self.startingPage, in: webView)
            case .reconnecting:
                showStatus("reconnecting", page: Self.reconnectingPage, in: webView)
            case .stopped:
                showStatus("stopped\(suffix)", page: Self.stoppedPage(funnelReady: funnelReady), in: webView)
            case .failed(let reason):
                showStatus("failed:\(reason)\(suffix)",
                           page: Self.failedPage(reason, funnelReady: funnelReady), in: webView)
            case .running:
                // running 但路由为 nil 不应发生（running 恒为 .embedded）；保险放等待页。
                showStatus("starting", page: Self.startingPage, in: webView)
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

        /// 6.1：在已装好的壳上盖一层原生重连浮层（不拆壳、不白屏、不假装在线）。
        /// 半透明遮罩拦截全部触摸，避免用户在桥断的瞬间继续触发会失败的操作。
        private func showReconnectOverlay(in webView: WKWebView) {
            if reconnectOverlay != nil { return }
            let dim = UIView()
            dim.translatesAutoresizingMaskIntoConstraints = false
            dim.backgroundColor = UIColor.black.withAlphaComponent(0.28)

            let card = UIView()
            card.translatesAutoresizingMaskIntoConstraints = false
            card.backgroundColor = UIColor.systemBackground
            card.layer.cornerRadius = 14
            let stack = UIStackView()
            stack.translatesAutoresizingMaskIntoConstraints = false
            stack.axis = .vertical
            stack.alignment = .center
            stack.spacing = 12

            let spinner = UIActivityIndicatorView(style: .large)
            spinner.translatesAutoresizingMaskIntoConstraints = false
            spinner.startAnimating()
            let label = UILabel()
            label.text = "tailnet 重连中…"
            label.font = .systemFont(ofSize: 15, weight: .medium)
            label.textColor = .label
            stack.addArrangedSubview(spinner)
            stack.addArrangedSubview(label)
            card.addSubview(stack)
            dim.addSubview(card)
            webView.addSubview(dim)
            NSLayoutConstraint.activate([
                dim.topAnchor.constraint(equalTo: webView.topAnchor),
                dim.bottomAnchor.constraint(equalTo: webView.bottomAnchor),
                dim.leadingAnchor.constraint(equalTo: webView.leadingAnchor),
                dim.trailingAnchor.constraint(equalTo: webView.trailingAnchor),
                card.centerXAnchor.constraint(equalTo: dim.centerXAnchor),
                card.centerYAnchor.constraint(equalTo: dim.centerYAnchor),
                card.widthAnchor.constraint(greaterThanOrEqualToConstant: 180),
                stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 22),
                stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -22),
                stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 28),
                stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -28)
            ])
            reconnectOverlay = dim
        }

        private func hideReconnectOverlay() {
            reconnectOverlay?.removeFromSuperview()
            reconnectOverlay = nil
        }

        // MARK: - 6.2 应急档原生条 / 状态页按钮 scheme

        /// 应急档顶部条：告知当前在 Funnel 降级线上，并提供「返回内网」。
        /// 盖在 WebView 顶部（页面自身不知道存在应急态，网关网页不改一行）。
        private func showFunnelBanner(in webView: WKWebView) {
            if funnelBanner != nil { return }
            let bar = UIView()
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.backgroundColor = UIColor.systemOrange
            let label = UILabel()
            label.translatesAutoresizingMaskIntoConstraints = false
            label.text = "应急通道（Funnel）· 本地草稿将在恢复内网后同步"
            label.textColor = .white
            label.font = .systemFont(ofSize: 12, weight: .medium)
            label.lineBreakMode = .byTruncatingTail
            let button = UIButton(type: .system)
            button.translatesAutoresizingMaskIntoConstraints = false
            button.setTitle("返回内网", for: .normal)
            button.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
            button.setTitleColor(.white, for: .normal)
            button.backgroundColor = UIColor.white.withAlphaComponent(0.22)
            button.layer.cornerRadius = 6
            button.contentEdgeInsets = UIEdgeInsets(top: 5, left: 10, bottom: 5, right: 10)
            button.addAction(UIAction { [weak self] _ in self?.exitEmergency() }, for: .touchUpInside)
            bar.addSubview(label)
            bar.addSubview(button)
            webView.addSubview(bar)
            NSLayoutConstraint.activate([
                bar.topAnchor.constraint(equalTo: webView.topAnchor),
                bar.leadingAnchor.constraint(equalTo: webView.leadingAnchor),
                bar.trailingAnchor.constraint(equalTo: webView.trailingAnchor),
                button.topAnchor.constraint(equalTo: bar.topAnchor, constant: 6),
                button.bottomAnchor.constraint(equalTo: bar.bottomAnchor, constant: -6),
                button.trailingAnchor.constraint(equalTo: bar.trailingAnchor, constant: -12),
                label.centerYAnchor.constraint(equalTo: bar.centerYAnchor),
                label.leadingAnchor.constraint(equalTo: bar.leadingAnchor, constant: 12),
                label.trailingAnchor.constraint(lessThanOrEqualTo: button.leadingAnchor, constant: -10)
            ])
            funnelBanner = bar
            // 让网页内容从条下方开始滚动（bar 高度约 38pt + 安全区由 WKWebView 自身 inset 处理）。
            var inset = webView.scrollView.contentInset
            inset.top = max(inset.top, 44)
            webView.scrollView.contentInset = inset
            webView.scrollView.scrollIndicatorInsets = inset
        }

        private func hideFunnelBanner(in webView: WKWebView) {
            guard funnelBanner != nil else { return }
            funnelBanner?.removeFromSuperview()
            funnelBanner = nil
            var inset = webView.scrollView.contentInset
            if inset.top >= 44 {
                inset.top -= 44
                webView.scrollView.contentInset = inset
                webView.scrollView.scrollIndicatorInsets = inset
            }
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

        /// 装载失败（内嵌壳或 Funnel）且非主动取消时清标记，使下一拍能重载。
        /// Funnel 失败补一张应急失败页（带重试/返回内网/去设置，不静默白屏）；内嵌失败仍走原失败页。
        private func handleShellFailure(_ error: Error) {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
            guard let web else { return }
            if loadedFunnel != nil {
                loadedFunnel = nil
                statusShown = nil
                hideFunnelBanner(in: web)
                showStatus("funnel-failed",
                           page: Self.funnelFailedPage(error.localizedDescription), in: web)
                return
            }
            guard loadedBase != nil else { return }
            loadedBase = nil
            showStatus("failed", page: Self.failedPage(error.localizedDescription, funnelReady: true), in: web)
        }

        /// 6.2：状态页/应急失败页按钮用 `dsh-action:<name>` 回调原生（这些页没有 dshBridge）。
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if let url = navigationAction.request.url, url.scheme == "dsh-action" {
                decisionHandler(.cancel)
                // dsh-action:<name> 是 opaque URL（无 host），动作名在冒号之后。
                let action = String(url.absoluteString.dropFirst("dsh-action:".count))
                switch action {
                case "use-emergency": useEmergency()
                case "exit-emergency": exitEmergency()
                case "open-settings": openSettings()
                case "retry": replayLastApply(to: web)
                default: break
                }
                return
            }
            decisionHandler(.allow)
        }

        /// 「重试」：按最近一次 apply 入参重放（funnel 失败 ⇒ loadedFunnel 已清，会重新发起请求）。
        private func replayLastApply(to webView: WKWebView) {
            guard let last = lastApply else { return }
            statusShown = nil
            apply(route: last.route, bridge: last.bridge, funnelReady: last.funnelReady, to: webView)
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
                // 6.2 状态页按钮：<a> 借 dsh-action: scheme 回调原生 decidePolicyFor。
                + "a.btn{display:inline-block;margin-top:4px;padding:10px 18px;border-radius:10px;"
                + "font-size:15px;font-weight:600;text-decoration:none;background:#3b82f6;color:#fff}"
                + "a.btn.ghost{background:#e5e7eb;color:#1c1c1e}"
                + "</style><body>\(body)</body>"
        }

        /// 桥启动中：App 冷启动自动入网 + 起反代通常需要数十秒（弱网更久）。
        static let startingPage = wrap(body:
            "<div class=\"spin\"></div><h3>正在连接内网…</h3>"
            + "<p>正在启动安全通道与本地服务，弱网下可能需要约一分钟。</p>")

        /// 桥停止：节点未认证（首启未喂 key）或已登出。已配置 Funnel 时给③档应急入口。
        static func stoppedPage(funnelReady: Bool) -> String {
            wrap(body:
                "<h3>内网通道未连接</h3>"
                + "<p>请点右上角「TS」完成一次入网，通道建立后会自动进入写作页。</p>"
                + emergencyActions(funnelReady: funnelReady))
        }

        /// 6.1 回前台重建中（壳尚未装好的极端时序才用；正常路径盖原生浮层不拆壳）。
        static let reconnectingPage = wrap(body:
            "<div class=\"spin\"></div><h3>tailnet 重连中…</h3>"
            + "<p>正在恢复本地安全通道，通常一秒内完成。</p>")

        /// 桥失败/壳加载失败：reason 转义后上屏，绝不静默白屏；带 Funnel 应急入口。
        static func failedPage(_ reason: String, funnelReady: Bool) -> String {
            let escaped = reason
                .replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
            return wrap(body:
                "<h3>本地通道不可用</h3>"
                + "<p>\(escaped)</p>"
                + "<p>请点右上角「TS」查看节点状态并重试。</p>"
                + emergencyActions(funnelReady: funnelReady))
        }

        /// 6.2 状态页应急动作组：已配置 Funnel ⇒ 一键进应急档；否则引导去 TS 设置页填地址。
        private static func emergencyActions(funnelReady: Bool) -> String {
            if funnelReady {
                return "<a class=\"btn\" href=\"dsh-action:use-emergency\">改用 Funnel 应急连接</a>"
            }
            return "<a class=\"btn ghost\" href=\"dsh-action:open-settings\">去「TS」设置 Funnel 应急地址</a>"
        }

        /// 6.2 应急档自身加载失败（Funnel 不可达/证书错等）：本地未上传草稿仍在 outbox 不丢。
        static func funnelFailedPage(_ reason: String) -> String {
            let escaped = reason
                .replacingOccurrences(of: "&", with: "&amp;")
                .replacingOccurrences(of: "<", with: "&lt;")
            return wrap(body:
                "<h3>应急通道也无法连接</h3>"
                + "<p>\(escaped)</p>"
                + "<p>本地未上传的草稿仍安全保留，恢复内网后会自动同步。</p>"
                + "<a class=\"btn\" href=\"dsh-action:retry\">重试应急连接</a>"
                + "<a class=\"btn ghost\" href=\"dsh-action:exit-emergency\">返回内网通道</a>")
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
