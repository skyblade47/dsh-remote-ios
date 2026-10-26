import SwiftUI
import WebKit

// ============================================================================
// Phase 2.4 spike —— WKWebView 经 http://127.0.0.1 本地桥访问 tailnet 的取证件
// （**非产品代码，闸门 B 结论固化后随 TailscaleSpike* 一起删除**）
//
// 三项取证：
//  ① 页面：加载 /auth/login，确认经本地桥渲染出真实页面（不是 ATS 拦截/502）；
//  ② Cookie：读 http://127.0.0.1 下 WKWebsiteDataStore 的 cookie 数，
//     登录后应出现 dsh_session（证明 Cookie 在 localhost origin 下可写可读）；
//  ③ WS：页面上下文里 new WebSocket(ws://127.0.0.1:<port>/api/remote.mux)，
//     未登录预期 401 close、登录后预期 101 open——网关 upgrade 要求 dsh_session。
// ============================================================================

@MainActor
final class SpikeWebModel: NSObject, ObservableObject {
    @Published var navLog: [String] = []
    @Published var cookieReport: String = "未读取"
    @Published var wsReport: String = "未探测"
    @Published var busy: Bool = false

    private(set) var webView: WKWebView?

    private let config: WKWebViewConfiguration = {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        return cfg
    }()

    func makeWebView() -> WKWebView {
        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.allowsBackForwardNavigationGestures = false
        self.webView = wv
        return wv
    }

    func load(_ url: URL) {
        logNav("→ load \(url.path)")
        webView?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func refreshCookies() {
        guard let wv = webView else { cookieReport = "WebView 未就绪"; return }
        wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            let names = cookies.map { "\($0.name)=\($0.value.prefix(6))…" }
            let hasSession = cookies.contains { $0.name == "dsh_session" }
            DispatchQueue.main.async {
                self?.cookieReport = "\(cookies.count) 条；dsh_session: \(hasSession ? "有 ✅" : "无")\n\(names.joined(separator: "\n"))"
            }
        }
    }

    /// 在页面 JS 上下文里连 /api/remote.mux（同源，自动带 cookie）。
    /// 8s 内：onopen=101（登录态正常）；onclose 1006 多为未登录 401，但 upgrade 已透传到网关。
    func probeWebSocket() {
        guard let wv = webView else { wsReport = "WebView 未就绪"; return }
        // 前置拦截：主框架不是 http 页面（about:blank/未加载/加载中）时，JS 的 location.origin
        // 为 "null"，new URL 会同步抛异常并让整个 Promise reject（evaluateJavaScript 直接报错）。
        guard let pageURL = wv.url, pageURL.scheme == "http", wv.isLoading == false else {
            wsReport = "页面未就绪：请先点「WKWebView 加载 /auth/login」，等导航轨迹出现「完成」后再探测（当前 \(wv.url?.absoluteString ?? "about:blank")）"
            return
        }
        busy = true
        wsReport = "探测中（最多 8s）…"
        // 用 callAsyncJavaScript（iOS14+）：函数体被包成 async function 并被原生 await，
        // 能可靠拿到跨 runloop（WebSocket 事件回调）才 resolve 的字符串。
        // evaluateJavaScript 对这种 Promise 会回 Code=5（result type unsupported）。
        let body = """
        return await new Promise((resolve) => {
          let done = false;
          const finish = (m) => { if (!done) { done = true; resolve(String(m)); } };
          const timer = setTimeout(() => finish('TIMEOUT 8s（无 open/close）'), 8000);
          try {
            if (!location.protocol.startsWith('http')) {
              clearTimeout(timer); finish('页面未加载（location=' + location.href + '），请先加载 /auth/login'); return;
            }
            const u = new URL('/api/remote.mux', location.origin);
            u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(u.toString());
            ws.onopen = () => { clearTimeout(timer); finish('OPEN 101 ✅（登录态，双向通道建立）'); };
            // onerror 在 WebKit 里必被随后的 onclose 跟随；以 onclose 的 code 为准，避免吞掉判定码。
            ws.onclose = (e) => { clearTimeout(timer); finish('CLOSE code=' + e.code + ' reason=' + (e.reason || '-') + (e.code === 1006 ? '（未登录多为网关 401 拒升级，仍证明 upgrade 字节已透传）' : '')); };
            ws.onerror = () => { /* 等 onclose 给 code；若仅 error 不 close 由 8s 超时兜底 */ };
          } catch (ex) { clearTimeout(timer); finish('JS 异常: ' + ex); }
        });
        """
        wv.callAsyncJavaScript(body, arguments: nil, in: nil, in: .page) { [weak self] result in
            DispatchQueue.main.async {
                self?.busy = false
                switch result {
                case .success(let value):
                    if let s = value as? String { self?.wsReport = s }
                    else { self?.wsReport = "无返回：\(String(describing: value))" }
                case .failure(let error):
                    self?.wsReport = "WS 探测失败：\(error)"
                }
            }
        }
    }

    fileprivate func logNav(_ line: String) {
        navLog.append(line)
        if navLog.count > 40 { navLog.removeFirst(navLog.count - 40) }
    }
}

extension SpikeWebModel: WKNavigationDelegate {
    nonisolated func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        Task { @MainActor in logNav("· 开始加载 \(webView.url?.path ?? "-")") }
    }
    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in logNav("· 完成 \(webView.url?.path ?? "-")") }
    }
    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        let msg = error.localizedDescription
        Task { @MainActor in logNav("· 失败：\(msg)") }
    }
    nonisolated func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let msg = error.localizedDescription
        Task { @MainActor in logNav("· 预加载失败（ATS/拒连/502?）：\(msg)") }
    }
    nonisolated func webView(_ webView: WKWebView,
                             didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation!) {
        Task { @MainActor in logNav("· 重定向 → \(webView.url?.absoluteString ?? "-")") }
    }
}

struct SpikeWebView: UIViewRepresentable {
    @ObservedObject var model: SpikeWebModel

    func makeUIView(context: Context) -> WKWebView {
        model.makeWebView()
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
