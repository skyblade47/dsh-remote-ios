import XCTest
@testable import DSHRemote

final class BridgeSyncSchemeHandlerTests: XCTestCase {
    private var tmp: URL!
    private var dataDir: URL!
    private var workspace: URL!
    private var dispatcher: BridgeDispatcher!
    private var bridge: BridgeSyncBridge!

    override func setUpWithError() throws {
        tmp = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("BridgeSyncTests-\(UUID().uuidString)", isDirectory: true)
        dataDir = tmp.appendingPathComponent("data", isDirectory: true)
        workspace = dataDir.appendingPathComponent("workspace", isDirectory: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        dispatcher = try BridgeDispatcher(dataDir: dataDir, workspaceRoot: workspace, appVersion: "0.1.0")
        bridge = BridgeSyncBridge(dispatcher: dispatcher)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: tmp)
    }

    private func request(method: String? = nil,
                         args: Any? = nil,
                         rawBody: Data? = nil,
                         urlString: String = "dsh-bridge://sync") -> URLRequest {
        var req = URLRequest(url: URL(string: urlString)!)
        req.httpMethod = "POST"
        if let rawBody {
            req.httpBody = rawBody
        } else {
            var dict: [String: Any] = [:]
            if let method { dict["method"] = method }
            if let args { dict["args"] = args }
            req.httpBody = try? JSONSerialization.data(withJSONObject: dict)
        }
        return req
    }

    private func json(_ answer: BridgeSyncBridge.Answer) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: answer.body) as? [String: Any]) ?? [:]
    }

    // MARK: - 探针兼容

    func testPingProbe() {
        let req = URLRequest(url: URL(string: "dsh-bridge://sync?m=__ping__")!)
        let answer = bridge.answer(to: req)
        XCTAssertEqual(answer.status, 200)
        XCTAssertTrue(answer.contentType.contains("application/json"))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, true)
    }

    // MARK: - 两个同步方法

    func testWriteDocSyncPersists() throws {
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["a/b.md", "hello"]))
        XCTAssertEqual(answer.status, 200)
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, true)
        XCTAssertEqual(map["bytes"] as? Int, 5)
        XCTAssertTrue((map["mtime"] as? NSNumber)?.int64Value ?? 0 > 0)
        // 落盘可经异步通道同款 readDoc 读回
        let read = dispatcher.dispatch("readDoc", args: ["a/b.md"])
        XCTAssertEqual(read["ok"] as? Bool, true)
        XCTAssertEqual(read["content"] as? String, "hello")
    }

    func testWriteDraftSyncReturnsKey() throws {
        // 对齐安卓 WcStorageBridge：writeDraftSync 仅两参 (relPath, content)
        let answer = bridge.answer(to: request(method: "writeDraftSync", args: ["w/a/x.md", "草稿正文"]))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, true)
        let key = map["key"] as? String ?? ""
        XCTAssertEqual(key.count, 24) // draftKeyFor = SHA1(root\nrelPath) 前 24 位 hex
        XCTAssertTrue(key.allSatisfy { "0123456789abcdef".contains($0) })
        XCTAssertEqual(map["bytes"] as? Int, 12) // "草稿正文" 4 字 × 3 字节
        // 草稿可经异步通道同款 readDraft 读回
        let read = dispatcher.dispatch("readDraft", args: ["w/a/x.md"])
        XCTAssertEqual(read["ok"] as? Bool, true)
        XCTAssertEqual(read["content"] as? String, "草稿正文")
    }

    // MARK: - 仅允许两个同步方法

    func testAsyncMethodRejected() {
        let answer = bridge.answer(to: request(method: "writeDoc", args: ["a/b.md", "x"]))
        XCTAssertEqual(answer.status, 200) // 业务失败走 200 + ok:false（对齐安卓 call() 不抛 HTTP 错）
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, false)
        let err = map["error"] as? String ?? ""
        XCTAssertTrue(err.contains("仅允许同步方法"))
    }

    func testUnknownMethodRejected() {
        let answer = bridge.answer(to: request(method: "nope", args: []))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, false)
    }

    // MARK: - 协议级畸形 → 400

    func testMissingBodyIs400() {
        let req = URLRequest(url: URL(string: "dsh-bridge://sync")!)
        XCTAssertEqual(bridge.answer(to: req).status, 400)
    }

    func testMalformedJSONIs400() {
        let answer = bridge.answer(to: request(rawBody: Data("{not json".utf8)))
        XCTAssertEqual(answer.status, 400)
    }

    func testBodyNotObjectIs400() {
        let answer = bridge.answer(to: request(rawBody: Data("[1,2]".utf8)))
        XCTAssertEqual(answer.status, 400)
    }

    func testMethodMissingOrNotStringIs400() {
        XCTAssertEqual(bridge.answer(to: request(method: nil, args: [])).status, 400)
        let answer = bridge.answer(to: request(rawBody: Data(#"{"method":42,"args":[]}"#.utf8)))
        XCTAssertEqual(answer.status, 400)
    }

    func testArgsNotArrayIs400() {
        let answer = bridge.answer(to: request(rawBody: Data(#"{"method":"writeDocSync","args":"x"}"#.utf8)))
        XCTAssertEqual(answer.status, 400)
    }

    func testArgsMissingDefaultsToEmpty() {
        // 缺 args 时按 [] 处理，交给 dispatcher 报业务失败（200/ok:false），不是协议 400
        let answer = bridge.answer(to: request(rawBody: Data(#"{"method":"writeDocSync"}"#.utf8)))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, false)
    }

    // MARK: - 业务失败透传（路径越界）

    func testPathTraversalIsBusinessFail() {
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["../escape.md", "x"]))
        let map = json(answer)
        XCTAssertEqual(map["ok"] as? Bool, false)
        XCTAssertNotNil(map["error"])
    }

    // MARK: - 大 body / 恶意内容往返

    func testLargeBodyRoundTrip() {
        let text = String(repeating: "段", count: 200_000) // 600KB UTF-8
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["big.md", text]))
        XCTAssertEqual(json(answer)["ok"] as? Bool, true)
        let read = dispatcher.dispatch("readDoc", args: ["big.md"])
        XCTAssertEqual(read["content"] as? String, text)
    }

    func testMaliciousContentRoundTrip() {
        let text = "</script>\"'\n\r\t\u{2028}中文"
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["evil.md", text]))
        XCTAssertEqual(json(answer)["ok"] as? Bool, true)
        let read = dispatcher.dispatch("readDoc", args: ["evil.md"])
        XCTAssertEqual(read["content"] as? String, text)
    }

    // MARK: - 应答头

    func testResponseHeaders() {
        let answer = bridge.answer(to: request(method: "writeDocSync", args: ["a/b.md", "z"]))
        XCTAssertTrue(answer.contentType.contains("application/json"))
        XCTAssertTrue(answer.contentType.lowercased().contains("utf-8"))
    }
}
