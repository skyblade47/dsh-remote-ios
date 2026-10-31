import SwiftUI
import WebKit

// ============================================================================
// Phase 4.8 —— localhost 反代真机数据面验收（产品化自 spike 2.4 SpikeWebView）。
//
// 三项真机取证（经 http://127.0.0.1:<port> 本地桥，不经 ATS/不经公网）：
//  ① 页面：加载 /auth/login，确认经本地桥渲染真实页面（不是 ATS 拦截/502）；
//  ② Cookie：读 127.0.0.1 origin 下 WKWebsiteDataStore 的 cookie，
//     登录后应出现 dsh_session（证明 Cookie 在 localhost origin 下可写可读）；
//  ③ WS：页面上下文 new WebSocket(ws://127.0.0.1:<port>/api/remote.mux)，
//     未登录预期 close 1006（网关 401 拒升级），登录后预期 open 101。
//
// 页面只观察 TailnetNode.shared 的 bridge 状态取 base；不持有节点、不触发起停桥。
// 这是验收入口（不是 Phase 5 的产品壳 WebView）：Phase 5 的 ShellWebView 改造另立任务。
// ============================================================================

@MainActor
final class TailnetVerifyModel: NSObject, ObservableObject {
    @Published var navLog: [String] = []
    @Published var cookieReport: String = "未读取"
    @Published var wsReport: String = "未探测"
    @Published var busy = false

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

    /// 加载本地桥的 /auth/login（相对 URL 防尾斜杠重定向错位）。
    func loadLogin(base: URL) {
        let url = URL(string: "auth/login", relativeTo: base)!.absoluteURL
        logNav("→ load \(url.path)")
        webView?.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func refreshCookies() {
        guard let wv = webView else { cookieReport = "WebView 未就绪"; return }
        wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            let names = cookies.map { "\($0.name)=\($0.value.prefix(6))…" }
            let hasSession = cookies.contains { $0.name == "dsh_session" }
            DispatchQueue.main.async {
                self?.cookieReport =
                    "\(cookies.count) 条；dsh_session: \(hasSession ? "有 ✅" : "无")\n\(names.joined(separator: "\n"))"
            }
        }
    }

    /// 在页面 JS 上下文连 /api/remote.mux（同源，自动带 cookie）。
    /// 8s 内：onopen=101（登录态）；onclose 1006 多为未登录 401，但 upgrade 已透传到网关。
    func probeWebSocket() {
        guard let wv = webView else { wsReport = "WebView 未就绪"; return }
        // 主框架不是 http 页面（about:blank/未加载）时 location.origin 为 "null"，new URL 同步抛错。
        guard let pageURL = wv.url, pageURL.scheme == "http", wv.isLoading == false else {
            wsReport = "页面未就绪：先加载 /auth/login，等导航轨迹出现「完成」后再探测"
            return
        }
        busy = true
        wsReport = "探测中（最多 8s）…"
        // callAsyncJavaScript（iOS14+）：函数体被包成 async function 并被原生 await，
        // 能可靠拿到跨 runloop（WebSocket 事件回调）才 resolve 的字符串。
        let body = """
        return await new Promise((resolve) => {
          let done = false;
          const finish = (m) => { if (!done) { done = true; resolve(String(m)); } };
          const timer = setTimeout(() => finish('TIMEOUT 8s（无 open/close）'), 8000);
          try {
            if (!location.protocol.startsWith('http')) {
              clearTimeout(timer); finish('页面未加载（location=' + location.href + '）'); return;
            }
            const u = new URL('/api/remote.mux', location.origin);
            u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
            const ws = new WebSocket(u.toString());
            ws.onopen = () => { clearTimeout(timer); finish('OPEN 101 ✅（登录态，双向通道建立）'); };
            // onerror 在 WebKit 里必被随后的 onclose 跟随；以 onclose 的 code 为准。
            ws.onclose = (e) => { clearTimeout(timer); finish('CLOSE code=' + e.code + ' reason=' + (e.reason || '-') + (e.code === 1006 ? '（未登录多为网关 401 拒升级，仍证明 upgrade 字节已透传）' : '')); };
            ws.onerror = () => { /* 等 onclose 给 code；8s 超时兜底 */ };
          } catch (ex) { clearTimeout(timer); finish('JS 异常: ' + ex); }
        });
        """
        wv.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { [weak self] result in
            DispatchQueue.main.async {
                self?.busy = false
                switch result {
                case .success(let value):
                    self?.wsReport = value as? String ?? "无返回：\(String(describing: value))"
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

extension TailnetVerifyModel: WKNavigationDelegate {
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

/// 真机验收入口：导航轨迹 + /auth/login 渲染 + cookie + WS 1006/101。
struct TailnetVerifyView: View {
    @ObservedObject private var node = TailnetNode.shared
    @StateObject private var model = TailnetVerifyModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("本地桥") {
                    if case .running(let base) = node.bridge, let url = URL(string: base) {
                        Text(base).font(.system(.footnote, design: .monospaced))
                        Button {
                            model.loadLogin(base: url)
                        } label: {
                            Label("WKWebView 加载 /auth/login", systemImage: "globe")
                        }
                    } else {
                        Text("桥未就绪（状态：\(bridgeHint)）。节点在线且本地反代「就绪」后才能验收。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section("页面") {
                    VerifyWebView(model: model)
                        .frame(height: 420)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }

                Section("WebSocket /api/remote.mux") {
                    Button {
                        model.probeWebSocket()
                    } label: {
                        Label("探测 WS（未登录 1006 / 登录后 101）", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    .disabled(model.busy)
                    Text(model.wsReport)
                        .font(.footnote)
                        .textSelection(.enabled)
                }

                Section("Cookie") {
                    Button {
                        model.refreshCookies()
                    } label: {
                        Label("读取 cookie（登录后应有 dsh_session）", systemImage: "person.crop.circle")
                    }
                    Text(model.cookieReport)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }

                Section("导航轨迹") {
                    if model.navLog.isEmpty {
                        Text("暂无").font(.footnote).foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(model.navLog.enumerated().reversed()), id: \.offset) { _, line in
                            Text(line)
                                .font(.system(.caption2, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .navigationTitle("反代验收")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("完成") { dismiss() }
                }
            }
        }
    }

    private var bridgeHint: String {
        switch node.bridge {
        case .stopped: return "未启动"
        case .starting: return "启动中…"
        case .running: return "就绪"
        case .reconnecting: return "重连中…"
        case .failed(let reason): return "异常：\(reason)"
        }
    }
}

/// UIViewRepresentable 包一层，命名与产品壳 ShellWebView 区分（Phase 5 才改壳）。
private struct VerifyWebView: UIViewRepresentable {
    @ObservedObject var model: TailnetVerifyModel

    func makeUIView(context: Context) -> WKWebView {
        model.makeWebView()
    }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
