import XCTest
@testable import DSHRemote

final class NativeBridgeTests: XCTestCase {

    var root: URL!
    var dispatcher: BridgeDispatcher!
    var sent: [(id: Any, json: String)]!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("NativeBridgeTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        dispatcher = try BridgeDispatcher(dataDir: root.appendingPathComponent("data"),
                                          workspaceRoot: root,
                                          appVersion: "0.1.0-test")
        sent = []
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    func makeBridge() -> NativeBridge {
        NativeBridge(dispatcher: dispatcher,
                     reply: { [weak self] id, json in self?.sent.append((id, json)) })
    }

    func drain(_ bridge: NativeBridge) {
        let done = expectation(description: "io drained")
        bridge.barrier { done.fulfill() }
        wait(for: [done], timeout: 5)
    }

    // MARK: - 解包入参

    func testDictionaryBodyDispatches() {
        let b = makeBridge()
        b.handle(body: ["id": 7, "method": "getState", "args": []])
        drain(b)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0].id as? Int, 7)
        let o = (try? JSONSerialization.jsonObject(with: Data(sent[0].json.utf8)) as? [String: Any]) ?? [:]
        XCTAssertEqual(o?["ok"] as? Bool, true)
        XCTAssertEqual(o?["platform"] as? String, "ipad")
    }

    func testJsonStringBodyDispatches() {
        let b = makeBridge()
        b.handle(body: #"{"id":8,"method":"getState","args":[]}"#)
        drain(b)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0].id as? Int, 8)
        XCTAssertTrue(sent[0].json.contains("\"ok\":true"))
    }

    func testPositionalArgsReachDispatcher() {
        let b = makeBridge()
        b.handle(body: ["id": 1, "method": "writeDoc", "args": ["作品A/第一章.md", "正文"]])
        drain(b)
        let box: [String: Any] = dispatcher.dispatch("outboxList", args: [])
        let entries = box["entries"] as? [[String: Any]]
        XCTAssertEqual(entries?.count, 1)
        XCTAssertEqual(entries?.first?["relPath"] as? String, "作品A/第一章.md")
    }

    func testArgsMissingBecomesEmptyArray() {
        let b = makeBridge()
        b.handle(body: ["id": 2, "method": "getState"])
        drain(b)
        XCTAssertEqual(sent.count, 1)
    }

    // MARK: - 畸形包不崩溃、不应答

    func testNonDictionaryBodyIgnored() {
        let b = makeBridge()
        b.handle(body: 42)
        b.handle(body: ["method", "getState"])
        b.handle(body: NSNull())
        b.handle(body: nil)
        XCTAssertEqual(sent.count, 0)
    }

    func testMissingIdIgnored() {
        let b = makeBridge()
        b.handle(body: ["method": "getState", "args": []])
        XCTAssertEqual(sent.count, 0)
    }

    func testInvalidJsonStringIgnored() {
        let b = makeBridge()
        b.handle(body: #"{"id":1,"method":"getState""#)
        XCTAssertEqual(sent.count, 0)
    }

    func testNonArrayArgsIgnored() {
        let b = makeBridge()
        b.handle(body: ["id": 3, "method": "getState", "args": "not-array"])
        XCTAssertEqual(sent.count, 0)
    }

    // MARK: - 应答脚本

    func testReplyScriptCallsGlobalResolverWithNumericId() {
        let script = NativeBridge.replyScript(id: 9, json: #"{"ok":true}"#)
        XCTAssertEqual(script, #"globalThis.__dshBridgeResolve(9, {"ok":true});"#)
    }

    func testReplyScriptQuotesStringId() {
        let script = NativeBridge.replyScript(id: "abc", json: #"{"ok":true}"#)
        XCTAssertEqual(script, #"globalThis.__dshBridgeResolve("abc", {"ok":true});"#)
    }

    func testIdEmbeddedWithJsonLiteralEncoding() {
        let script = NativeBridge.replyScript(id: "a\nb", json: "{}")
        XCTAssertTrue(script.contains(#""a\nb""#))
        XCTAssertFalse(script.contains("\n"))
    }

    func testReplyJsonIsAlwaysParseableObject() {
        let b = makeBridge()
        b.handle(body: ["id": 1, "method": "未知方法XYZ", "args": []])
        drain(b)
        XCTAssertEqual(sent.count, 1)
        let reparsed = (try? JSONSerialization.jsonObject(
            with: Data(sent[0].json.utf8)) as? [String: Any]) ?? [:]
        XCTAssertEqual(reparsed?["ok"] as? Bool, false)
        XCTAssertTrue((reparsed?["error"] as? String ?? "").contains("未知方法"))
    }

    // MARK: - 入参 JSON 字符串转义（防注入）

    func testContentWithScriptBreakingCharsRoundTrips() {
        let b = makeBridge()
        let evil = "</script>\"'\n\r\t\u{2028}中文"
        b.handle(body: ["id": 5, "method": "writeDoc", "args": ["a.md", evil]])
        drain(b)
        XCTAssertEqual(sent.count, 1)
        let r = dispatcher.dispatch("readDoc", args: ["a.md"])
        XCTAssertEqual(r["content"] as? String, evil)
    }

    // MARK: - 同步执行语义（测试队列同步等待；生产队列串行）

    func testIOIsSerializedViaQueue() {
        let b = makeBridge()
        let done = expectation(description: "100 calls drained")
        for i in 0..<100 {
            b.handle(body: ["id": i, "method": "hash12", "args": ["x\(i)"]])
        }
        b.barrier { done.fulfill() }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(sent.count, 100)
        let ids = Set(sent.map { "\($0.id)" })
        XCTAssertEqual(ids.count, 100)
    }
}
