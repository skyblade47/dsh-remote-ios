import Foundation
import UIKit
import WebKit

// App 切后台（scenePhase == .background）时让写作页同步收尾：
// 执行 writing.js 暴露的 window.__wcFlushOnSessionEnd()（内部 flushSync → writeDocSync 同步 XHR）。
// 对齐 PC Electron main.js 的 session-end executeJavaScript；iOS 上 pagehide 不会因切后台触发。
final class BackgroundFlusher {

    /// 固定脚本：逐字对齐 Electron main.js:756，契约由 BackgroundFlusherTests 钉死。
    static let flushScript = "window.__wcFlushOnSessionEnd && window.__wcFlushOnSessionEnd()"

    /// (脚本, completion)：生产即 WKWebView.evaluateJavaScript 的形状；测试传内存桩。
    typealias Evaluator = (String, @escaping (Error?) -> Void) -> Void

    // 注入点：续命任务的 begin/end（生产包 UIApplication，测试传内存桩）
    private let beginTask: (@escaping () -> Void) -> AnyHashable?
    private let endTask: (AnyHashable) -> Void

    // 内核只认 evaluator 闭包；未绑定（网关未配置、壳未载入）为 nil
    private var evaluator: Evaluator?
    private var flushing = false

    init(begin: @escaping (@escaping () -> Void) -> AnyHashable?,
         end: @escaping (AnyHashable) -> Void) {
        self.beginTask = begin
        self.endTask = end
    }

    func bind(evaluator: @escaping Evaluator) {
        self.evaluator = evaluator
    }

    func unbind() {
        self.evaluator = nil
    }

    func flush() {
        // 解绑/未绑定：静默，不申请后台时间
        guard let evaluator else { return }
        // 重入：上一轮 completion 未回时跳过，避免后台抖动触发多次同步落盘
        guard !flushing else { return }
        flushing = true

        var token: AnyHashable?
        var ended = false
        let finishOnce: () -> Void = { [weak self] in
            guard !ended else { return }
            ended = true
            if let token { self?.endTask(token) }
            self?.flushing = false
        }

        token = beginTask {
            // 系统提前收回后台时间：立即收尾，迟到的 evaluateJavaScript 回调因 ended 被吞
            finishOnce()
        }

        // evaluator 内部在生产侧已切主线程（见 bind(webView:)）；此处直接调用
        evaluator(Self.flushScript) { _ in
            // 不看返回值/错误：session-end 本就是尽力而为（对齐 Electron）
            finishOnce()
        }
    }
}

extension BackgroundFlusher {

    /// 生产绑定：弱持有 WKWebView，求值时回主线程（WKWebView 必须主线程使用）。
    func bind(webView: WKWebView) {
        bind { [weak webView] script, completion in
            let doEvaluate: () -> Void = {
                _ = webView?.evaluateJavaScript(script) { _, error in completion(error) }
            }
            if Thread.isMainThread { doEvaluate() }
            else { DispatchQueue.main.async(execute: doEvaluate) }
        }
    }
}

extension BackgroundFlusher {

    /// 生产便捷构造：接 UIApplication 的后台任务时间。
    convenience init(live: Void = ()) {
        self.init(
            begin: { expiration in
                let token = UIApplication.shared.beginBackgroundTask(withName: "dsh-writing-flush") {
                    expiration()
                }
                return token == .invalid ? nil : AnyHashable(token.rawValue)
            },
            end: { raw in
                guard let value = raw.base as? Int else { return }
                UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: value))
            })
    }
}
