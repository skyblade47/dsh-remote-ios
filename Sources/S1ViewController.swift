import UIKit
import WebKit

/// S1 自检页（标题连点 5 次进入；仅调试/验收用）。
///
/// Phase 5 起全程走 localhost 反代（`loopbackBase` = http://127.0.0.1:<port>）：
///   1) 先加载反代的 /auth/login 真实登录种 dsh_session cookie（与产品壳同一数据存储）；
///   2) 点按钮后以反代 shell URL 为 base 装载五探针页（http loopback origin）。
/// 探针⑤注册**真实的** BridgeSyncSchemeHandler（共用 BridgeDispatcher 内核），
/// 用于 Task 5.6 在 http loopback origin 下实测自定义 scheme 同步 XHR 是否仍可用。
final class S1ViewController: UIViewController {
    private let loopbackBase: String
    private var web: WKWebView!

    private let startButton: UIButton = {
        let b = UIButton(type: .system)
        b.setTitle("已登录，运行五探针", for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        b.backgroundColor = .tintColor
        b.setTitleColor(.white, for: .normal)
        b.layer.cornerRadius = 10
        return b
    }()

    init(loopbackBase: String?) {
        self.loopbackBase = loopbackBase ?? ""
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "S1 验证"

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()

        // 探针⑤：http loopback origin 下的 dsh-bridge:// 同步 XHR（5.6 真机实测对象）。
        // 用真实 dispatcher，与产品壳同一同步写盘内核（非假应答）。
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let container = docs.appendingPathComponent("workspace", isDirectory: true)
        if let dispatcher = try? BridgeDispatcher(
            dataDir: docs, workspaceRoot: container,
            multiWorkspace: true, appVersion: "0.1.0") {
            cfg.setURLSchemeHandler(BridgeSyncSchemeHandler(dispatcher: dispatcher),
                                    forURLScheme: "dsh-bridge")
        }

        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        cfg.userContentController.add(LeaklessProxy(self), name: "s1Report")
        web.customUserAgent = ((web.value(forKey: "userAgent") as? String) ?? "") + " DSHRemote/0.1.0"

        view.addSubview(web)
        view.addSubview(startButton)
        web.translatesAutoresizingMaskIntoConstraints = false
        startButton.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            startButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            startButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
            startButton.widthAnchor.constraint(greaterThanOrEqualToConstant: 200),
            startButton.heightAnchor.constraint(equalToConstant: 48)
        ])
        startButton.addTarget(self, action: #selector(runProbes), for: .touchUpInside)

        // ① 经反代真实登录种 cookie（base 无尾斜杠，URL(relativeTo:) 防重定向）
        if let baseURL = URL(string: loopbackBase),
           let login = URL(string: "auth/login", relativeTo: baseURL) {
            var request = URLRequest(url: login)
            request.cachePolicy = .reloadIgnoringLocalCacheData
            web.load(request)
        } else {
            web.loadHTMLString("<meta charset=utf-8><body style='padding:24px'>反代未就绪，无法自检。</body>",
                               baseURL: URL(string: "about:blank")!)
        }
    }

    @objc private func runProbes() {
        // DIAG-G：先用 App 进程 URLSession 直连 loopback 采集真值（不经 WebKit），再装载探针页。
        Task { @MainActor in
            let native = await Self.nativeLoopbackDiag(base: self.loopbackBase)
            guard let baseURL = URL(string: self.loopbackBase) else { return }
            self.web.loadHTMLString(
                S1ProbePage.html(loopbackOrigin: self.loopbackBase, nativeDiag: native),
                baseURL: baseURL)
        }
    }

    /// DIAG-G（临时）：原生侧直连 `http://127.0.0.1:<port>` 的真值。
    /// 与 WebKit 完全无关：若此通道 ping 得到 pong，说明 listener + HttpBridge 健康，
    /// 那 WKWebView 里清一色"404 空 body"只能是被 WebKit 侧合成；反之则端口上应答的不是我们的桥。
    private static func nativeLoopbackDiag(base: String) async -> String {
        var lines: [String] = []
        lines.append("loopbackBase=" + base)
        lines.append("persisted=" + (UserDefaults.standard
            .string(forKey: LoopbackProxy.baseURLDefaultsKey) ?? "(nil)"))

        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 8
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.httpShouldUsePipelining = false
        let session = URLSession(configuration: cfg)

        func hit(_ path: String) async -> String {
            guard let u = URL(string: path, relativeTo: URL(string: base)) else {
                return path + " -> URL 构造失败"
            }
            do {
                let (data, resp) = try await session.data(from: u)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
                let body = String(decoding: data.prefix(90), as: UTF8.self)
                    .replacingOccurrences(of: "\n", with: " ")
                return "\(path) -> status=\(code) bytes=\(data.count) body=\(body)"
            } catch {
                return "\(path) -> EXC \(error.localizedDescription)"
            }
        }

        for p in ["/__shell__/ping", "/__shell__/diag", "/zzz/plain", "/auth/login"] {
            lines.append(await hit(p))
        }
        let ringLine = await hit("/diag-log?read=1")
        lines.append("环(上述4发之后)=" + ringLine)
        return lines.joined(separator: "\n")
    }
}

extension S1ViewController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        NSLog("[dsh-ios][s1] didFinish \(webView.url?.absoluteString ?? "-")")
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[dsh-ios][s1] provisional fail \(error.localizedDescription)")
    }
}

extension S1ViewController: WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "s1Report" else { return }
        NSLog("[dsh-ios][s1-report] \(message.body)")
    }
}

private final class LeaklessProxy: NSObject, WKScriptMessageHandler {
    weak var target: S1ViewController?
    init(_ t: S1ViewController) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
