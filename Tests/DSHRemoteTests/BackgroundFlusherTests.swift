import XCTest
@testable import DSHRemote

final class BackgroundFlusherTests: XCTestCase {

    private var begins: Int = 0
    private var ended: [AnyHashable] = []
    private var expirations: [() -> Void] = []
    private var evaluated: [String] = []

    private func makeHarness(token: AnyHashable? = 7) -> BackgroundFlusher {
        begins = 0
        ended = []
        expirations = []
        evaluated = []
        return BackgroundFlusher(
            begin: { [weak self] work in
                self?.begins += 1
                if let work { self?.expirations.append(work) }
                return token
            },
            end: { [weak self] t in self?.ended.append(t) })
    }

    // MARK: - 脚本契约（与 Electron main.js:756 同一句）

    func testFlushScriptMatchesSessionEndHook() {
        XCTAssertEqual(
            BackgroundFlusher.flushScript,
            "window.__wcFlushOnSessionEnd && window.__wcFlushOnSessionEnd()")
    }

    // MARK: - 正常路径

    func testFlushEvaluatesScriptAndBeginsEndsTask() {
        let flusher = makeHarness()
        flusher.bind(evaluator: { [weak self] script, completion in
            self?.evaluated.append(script)
            completion(nil)
        })
        flusher.flush()
        XCTAssertEqual(begins, 1)
        XCTAssertEqual(evaluated, [BackgroundFlusher.flushScript])
        XCTAssertEqual(ended, [7])
    }

    func testCompletionFinishesEvenWhenEvaluateErrors() {
        let flusher = makeHarness()
        flusher.bind(evaluator: { $1(NSError(domain: "t", code: 1)) })
        flusher.flush()
        XCTAssertEqual(ended, [7])
    }

    // MARK: - 续命配对

    func testExpirationEndsTaskAndDoesNotCrash() {
        let flusher = makeHarness()
        flusher.bind(evaluator: { _, _ in /* 永不回调，模拟被挂起 */ })
        flusher.flush()
        XCTAssertTrue(ended.isEmpty)
        expirations[0]() // 系统提前收回
        XCTAssertEqual(ended, [7])
    }

    func testExpirationThenLateCompletionEndsOnlyOnce() {
        let flusher = makeHarness()
        var done: ((Error?) -> Void)?
        flusher.bind(evaluator: { done = $1 })
        flusher.flush()
        expirations[0]()
        done?(nil) // 迟到的完成回调
        XCTAssertEqual(ended, [7])
    }

    func testInvalidTokenStillEvaluatesOnce() {
        let flusher = makeHarness(token: nil)
        flusher.bind(evaluator: { [weak self] _, completion in
            self?.evaluated.append("x")
            completion(nil)
        })
        flusher.flush()
        XCTAssertEqual(begins, 1)
        XCTAssertEqual(evaluated.count, 1)
        XCTAssertTrue(ended.isEmpty) // 无 token 可 end
    }

    // MARK: - 重入 / 解绑 / 无 web

    func testReentrantFlushIsSkipped() {
        let flusher = makeHarness()
        var firstDone: ((Error?) -> Void)?
        flusher.bind(evaluator: { firstDone = $1 })
        flusher.flush()
        flusher.flush() // 第一次未完成 → 跳过：不重复 begin、不重复求值
        XCTAssertEqual(begins, 1)
        firstDone?(nil)
        flusher.flush() // 完成后再进后台 → 新一轮
        XCTAssertEqual(begins, 2)
        firstDone?(nil) // 第二轮的 completion（evaluator 每次把 $1 重新赋给 firstDone）
        XCTAssertEqual(ended, [7, 7])
    }

    func testFlushBeforeBindIsSilentNoop() {
        let flusher = makeHarness()
        flusher.flush() // 没有 webView（如网关未配置时切后台）
        XCTAssertEqual(begins, 0)
        XCTAssertTrue(ended.isEmpty)
    }

    func testFlushAfterUnbindIsSilentNoop() {
        let flusher = makeHarness()
        flusher.bind(evaluator: { $1(nil) })
        flusher.unbind()
        flusher.flush()
        XCTAssertEqual(begins, 0)
        XCTAssertTrue(ended.isEmpty)
    }
}
