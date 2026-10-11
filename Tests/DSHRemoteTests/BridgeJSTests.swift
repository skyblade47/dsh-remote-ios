import XCTest
import JavaScriptCore
@testable import DSHRemote

final class BridgeJSTests: XCTestCase {

    var ctx: JSContext!
    var posted: [[String: Any]]!
    var syncCalls: [[String: Any]]!

    override func setUp() {
        super.setUp()
        ctx = JSContext()
        posted = []
        syncCalls = []
        ctx.exceptionHandler = { _, ex in
            XCTFail("JS 异常: \(ex?.toString() ?? "-")")
        }
        // postMessage 桩：抓取异步通道包
        let post: @convention(block) (JSValue?) -> Void = { [weak self] msg in
            if let d = msg?.toDictionary() as? [String: Any] { self?.posted.append(d) }
        }
        let handlers = JSValue(newObjectIn: ctx)
        let dsh = JSValue(newObjectIn: ctx)
        dsh?.setObject(JSValue(object: post, in: ctx), forKeyedSubscript: "postMessage" as NSString)
        handlers?.setObject(dsh, forKeyedSubscript: "dshBridge" as NSString)
        let webkit = JSValue(newObjectIn: ctx)
        webkit?.setObject(handlers, forKeyedSubscript: "messageHandlers" as NSString)
        ctx.setObject(webkit, forKeyedSubscript: "webkit" as NSString)
        // 同步 XHR 桩：Task 10 的 dsh-bridge://sync 行为在此模拟
        let xhrCtor: @convention(block) () -> JSValue? = { [weak self] in
            let x = JSValue(newObjectIn: self?.ctx)
            x?.setObject(true, forKeyedSubscript: "isDSHSync" as NSString)
            x?.setObject(200, forKeyedSubscript: "status" as NSString)
            x?.setObject(JSValue(object: { (method: String, url: String, async: Bool) in
                x?.setObject(url, forKeyedSubscript: "__url" as NSString)
                x?.setObject(async, forKeyedSubscript: "__async" as NSString)
            } as @convention(block) (String, String, Bool) -> Void, in: ctx),
                forKeyedSubscript: "open" as NSString)
            x?.setObject(JSValue(object: { (body: String) in
                guard let data = body.data(using: .utf8),
                      let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { return }
                self?.syncCalls.append(parsed)
                let m = parsed["method"] as? String ?? ""
                let resp: [String: Any]
                if m == "writeDocSync" { resp = ["ok": true, "mtime": 123, "bytes": 3] }
                else if m == "writeDraftSync" { resp = ["ok": true, "key": "k"] }
                else { resp = ["ok": false, "error": "only-sync-methods"] }
                let d = (try? JSONSerialization.data(withJSONObject: resp)) ?? Data()
                x?.setObject(String(data: d, encoding: .utf8),
                             forKeyedSubscript: "responseText" as NSString)
            } as @convention(block) (String) -> Void, in: ctx),
                forKeyedSubscript: "send" as NSString)
            return x
        }
        ctx.setObject(JSValue(object: xhrCtor, in: ctx), forKeyedSubscript: "XMLHttpRequest" as NSString)
        // JSC 不自带 window 自引用（WKWebView 里有）；注入脚本以 window/globalThis 并用
        ctx.evaluateScript("if (!globalThis.window) { globalThis.window = globalThis; }")
        ctx.evaluateScript(BridgeJS.source)
    }

    // MARK: - 结构断言（字符串契约）

    func testOwnsHostDeclared() {
        XCTAssertTrue(BridgeJS.source.contains("globalThis.__DSH_TRANSPORT__ = { ownsHost: true }"))
    }

    func testResolverAndPostMessageContract() {
        XCTAssertTrue(BridgeJS.source.contains("globalThis.__dshBridgeResolve ="))
        XCTAssertTrue(BridgeJS.source.contains("window.webkit.messageHandlers.dshBridge.postMessage"))
    }

    func testTenSecondTimeout() {
        XCTAssertTrue(BridgeJS.source.contains("10000"))
    }

    func testSyncChannelPostsToBridgeScheme() {
        XCTAssertTrue(BridgeJS.source.contains("dsh-bridge://sync"))
    }

    func testAllAndroidApiMethodsPresent() {
        let expected = [
            "getState", "listWorkspace", "readDoc", "writeDoc", "writeDocSync",
            "createWork", "createDoc", "renameWork", "renameDoc", "moveDoc",
            "trashDoc", "trashWork", "listTrash", "restoreTrash", "purgeTrash",
            "saveConfig", "writeDraft", "writeDraftSync", "readDraft", "clearDraft",
            "listPendingDrafts", "draftsUsage", "getLastSession", "proofSave", "proofLoad",
            "syncBaseline", "syncBaselineSet", "appendPomodoro", "outboxList", "outboxRemove",
            "nativeOnline", "reportDirty", "onFlushRequest", "flushDone", "relaunch",
            "scheduleReminder", "cancelReminder", "getDeviceId", "hash12",
            "pickRoot", "pickDir", "pickImportFiles", "pickImportDir", "importInto",
            "onImportProgress", "notifyWriting"
        ]
        XCTAssertEqual(expected.count, 46)
        for m in expected {
            XCTAssertTrue(BridgeJS.source.contains(m), "白名单缺少 \(m)")
        }
    }

    func testWcWritingShimExposesHash12() {
        XCTAssertTrue(BridgeJS.source.contains("window.wcWriting"))
        XCTAssertTrue(BridgeJS.source.contains("kind: 'ipad'"))
        XCTAssertTrue(BridgeJS.source.contains("hash12"))
    }

    // MARK: - 行为断言（JavaScriptCore）

    func flushMicrotasks(_ n: Int = 3) {
        for _ in 0..<n { _ = ctx.objectForKeyedSubscript("Promise" as NSString)?
            .invokeMethod("resolve", withArguments: [])
            .invokeMethod("then", withArguments: [{} as @convention(block) () -> Void]) }
    }

    func testAsyncCallPostsIdMethodArgs() {
        ctx.evaluateScript("window.wcStorage.getState().then(function(){})")
        XCTAssertEqual(posted.count, 1)
        XCTAssertNotNil(posted[0]["id"])
        XCTAssertEqual(posted[0]["method"] as? String, "getState")
        XCTAssertEqual((posted[0]["args"] as? [Any])?.count, 0)
    }

    func testResolveByIdFulfillsPromise() {
        let done = expectation(description: "promise resolved")
        ctx.setObject(JSValue(object: { (ok: Bool) in
            if ok { done.fulfill() }
        } as @convention(block) (Bool) -> Void, in: ctx),
            forKeyedSubscript: "__testDone" as NSString)
        ctx.evaluateScript(
            "window.wcStorage.getState().then(function(r){ __testDone(r.ok === true) })")
        let id = posted[0]["id"] as? Int ?? 0
        ctx.evaluateScript("globalThis.__dshBridgeResolve(\(id), {ok:true})")
        wait(for: [done], timeout: 2)
    }

    func testArgsPassedPositionally() {
        ctx.evaluateScript("window.wcStorage.writeDoc('a/b.md', '正文')")
        let args = posted[0]["args"] as? [Any]
        XCTAssertEqual(args?.count, 2)
        XCTAssertEqual(args?.first as? String, "a/b.md")
    }

    func testSyncMethodsUseXHRAndReturnValue() {
        // 不比较 JSON 键序（桩与原生序列化器的键序可能不同），按解析后的字段断言
        let r = ctx.evaluateScript(
            "var x = window.wcStorage.writeDocSync('a/b.md','z');"
            + "JSON.stringify({ok:x.ok,mtime:x.mtime,bytes:x.bytes})")?.toString()
        XCTAssertEqual(r, #"{"ok":true,"mtime":123,"bytes":3}"#)
        XCTAssertEqual(syncCalls.count, 1)
        XCTAssertEqual(syncCalls[0]["method"] as? String, "writeDocSync")
        XCTAssertEqual((syncCalls[0]["args"] as? [Any])?.count, 2)
        XCTAssertEqual(posted.count, 0)
    }

    func testAsyncMethodDoesNotUseXHR() {
        ctx.evaluateScript("window.wcStorage.listWorkspace()")
        XCTAssertEqual(syncCalls.count, 0)
        XCTAssertEqual(posted.count, 1)
    }

    func testWcWritingHash12IsAsync() {
        ctx.evaluateScript(
            "window.wcWriting.hash12('abc').then(function(){})")
        XCTAssertEqual(posted.last?["method"] as? String, "hash12")
    }

    func testShellCanOverrideMethodWithFunction() {
        ctx.evaluateScript(
            "window.wcStorage.getState = function(){return 'overridden'}")
        let r = ctx.evaluateScript("window.wcStorage.getState()")?.toString()
        XCTAssertEqual(r, "overridden")
        XCTAssertEqual(posted.count, 0)
    }
}
