import UIKit
import WebKit

final class S1ViewController: UIViewController {
    private let gatewayOrigin: String
    private var web: WKWebView!
    private var loggedIn = false

    private let startButton: UIButton = {
        let b = UIButton(type: .system)
        b.setTitle("已登录，运行四探针", for: .normal)
        b.titleLabel?.font = .systemFont(ofSize: 16, weight: .semibold)
        b.backgroundColor = .tintColor
        b.setTitleColor(.white, for: .normal)
        b.layer.cornerRadius = 10
        return b
    }()

    init(gatewayOrigin: String) {
        self.gatewayOrigin = gatewayOrigin
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        title = "S1 验证"

        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
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

        web.load(URLRequest(url: URL(string: gatewayOrigin + "/auth/login")!))
    }

    @objc private func runProbes() {
        web.loadHTMLString(S1ProbePage.html(gatewayOrigin: gatewayOrigin),
                           baseURL: URL(string: gatewayOrigin + "/__shell__/shell.html")!)
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
