import XCTest
@testable import DSHRemote

// ============================================================================
// Phase 3.4 —— TailnetNode 状态机单测（不引 Go、不碰真网络/真 Keychain）。
//   - InMemoryAuthStore：AuthKeyStoring 内存替身。
//   - FakeTailnetBackend：TailnetBackending 假后端，可编程 online/抛错/双空地址/挂起，
//     并记录每次 bringUp 入参（用于断言恢复时 authKey=nil、配置常量正确）。
//   - 状态目录注入临时 URL，tearDown 删除；hasPersistedState 走真实磁盘探测。
// ============================================================================

// MARK: - 替身

private final class InMemoryAuthStore: AuthKeyStoring {
    var key: String?

    func loadAuthKey() -> String? { key }
    func saveAuthKey(_ k: String) -> Bool {
        let trimmed = k.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        key = trimmed
        return true
    }
    func deleteAuthKey() -> Bool { key = nil; return true }
    func hasAuthKey() -> Bool { key != nil }
}

/// bringUp 的脚本：成功给地址 / 抛错 / 双空（up 成功但无地址）/ 挂起直到释放。
/// failure 关联具体 Sendable 错误类型（actor 存储不能持有非 Sendable 的 Error existential）。
private enum FakeOutcome {
    case online(ip4: String?, ip6: String?)
    case failure(BoomError)
    case noAddresses
    case hang
}

private struct BoomError: Error, Equatable {
    let message: String
}

private actor FakeTailnetBackend: TailnetBackending {
    struct Call: Equatable {
        let stateDir: String
        let hostName: String
        let controlURL: String
        let authKey: String?
    }

    private let outcome: FakeOutcome
    /// 4.1：online 后是否向节点提供 tailscale handle。默认 nil（不起真实 loopback，
    /// 保持节点状态机用例快测）；桥装配用例注入假值，并把期望的起桥失败记为无真实 dial。
    private let handle: Int32?
    private(set) var calls: [Call] = []
    private(set) var shutdownCount = 0
    private(set) var dialHandleCalls = 0
    private var hang: CheckedContinuation<(ip4: String?, ip6: String?), Error>?

    init(outcome: FakeOutcome, handle: Int32? = nil) {
        self.outcome = outcome
        self.handle = handle
    }

    func bringUp(stateDir: URL, hostName: String, controlURL: String,
                 authKey: String?) async throws -> (ip4: String?, ip6: String?) {
        calls.append(Call(stateDir: stateDir.path, hostName: hostName,
                          controlURL: controlURL, authKey: authKey))
        switch outcome {
        case .online(let ip4, let ip6):
            return (ip4, ip6)
        case .failure(let error):
            throw error
        case .noAddresses:
            return (nil, nil)
        case .hang:
            return try await withCheckedThrowingContinuation { cont in
                self.hang = cont
            }
        }
    }

    func shutdown() async {
        shutdownCount += 1
        // 模拟 down 中断挂起的 up，释放用例里卡住的 bringUp（并清掉孤立 Task）。
        hang?.resume(throwing: CancellationError())
        hang = nil
    }

    /// 4.1：节点 online 后本地桥来取 handle；记录调用次数，默认给 nil（不起真实桥）。
    func dialHandle() async -> Int32? {
        dialHandleCalls += 1
        return handle
    }

    /// 测试主动释放挂起：resume 为指定结果。
    func releaseHang(outcome: FakeOutcome) {
        guard let cont = hang else { return }
        switch outcome {
        case .online(let ip4, let ip6): cont.resume(returning: (ip4, ip6))
        case .failure(let error): cont.resume(throwing: error)
        case .noAddresses: cont.resume(returning: (nil, nil))
        case .hang: break
        }
        hang = nil
    }

    func lastCall() -> Call? { calls.last }
    func callCount() -> Int { calls.count }
    func shutdowns() -> Int { shutdownCount }
}

/// 「每次 bringUp 取队列里下一个假后端」的工厂收集器：
/// 既按序供应后端，又保留已创建引用，供用例事后取第 n 个后端的调用记录。
/// 仅 MainActor 上存取（make() 同步调用），锁只满足编译器的 Sendable 检查。
private final class BackendQueue: @unchecked Sendable {
    private var pending: [FakeTailnetBackend] = []
    private var created: [FakeTailnetBackend] = []
    private let lock = NSLock()

    func append(_ b: FakeTailnetBackend) {
        lock.lock(); defer { lock.unlock() }
        pending.append(b)
    }

    func make() -> TailnetBackending {
        lock.lock(); defer { lock.unlock() }
        let b = pending.removeFirst()
        created.append(b)
        return b
    }

    func createdCount() -> Int {
        lock.lock(); defer { lock.unlock() }
        return created.count
    }

    func backend(at index: Int) -> FakeTailnetBackend {
        lock.lock(); defer { lock.unlock() }
        return created[index]
    }
}

// MARK: - 用例

@MainActor
final class TailnetNodeTests: XCTestCase {

    private var tempDir: URL!
    private var auth: InMemoryAuthStore!

    override func setUp() async throws {
        try await super.setUp()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("TailnetNodeTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        auth = InMemoryAuthStore()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: tempDir)
        auth = nil
        tempDir = nil
        try await super.tearDown()
    }

    // MARK: - 工具

    @discardableResult
    private func seedState() throws -> URL {
        let f = tempDir.appendingPathComponent("tailscaled.state")
        try Data("fake-node-credential".utf8).write(to: f)
        return f
    }

    private func makeNode(_ backend: TailnetBackending) -> TailnetNode {
        TailnetNode(authStore: auth, stateDirectory: tempDir) { backend }
    }

    private func makeNodeQueue(_ queue: BackendQueue) -> TailnetNode {
        TailnetNode(authStore: auth, stateDirectory: tempDir) { queue.make() }
    }

    /// 3.5：注入短看门狗超时（生产 45s，用例不能真等）。
    private func makeNode(_ backend: TailnetBackending, bringUpTimeout: TimeInterval) -> TailnetNode {
        TailnetNode(authStore: auth, stateDirectory: tempDir,
                    bringUpTimeout: bringUpTimeout) { backend }
    }

    /// 等到状态进入 failed（fire-and-forget 超时回调有调度延迟）。
    private func waitForFailed(_ node: TailnetNode) async {
        for _ in 0..<300 {
            if case .failed = node.state { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// 等状态离开 starting；signIn/retry 内部 settle 已 await，这里只防调度抖动。
    private func waitForSettle(_ node: TailnetNode) async {
        for _ in 0..<200 {
            if case .starting = node.state {
                try? await Task.sleep(nanoseconds: 20_000_000)
            } else {
                return
            }
        }
    }

    /// 轮询等状态进入 starting（fire-and-forget 的 bringUp 有启动延迟）。
    private func waitForStarting(_ node: TailnetNode) async {
        for _ in 0..<200 {
            if case .starting = node.state { return }
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    /// 4.1：online 后桥在独立 Task 里起（真 NWListener bind 127.0.0.1），轮询等其离开 .starting。
    private func waitForBridge(_ node: TailnetNode) async {
        for _ in 0..<300 {
            if case .starting = node.bridge {
                try? await Task.sleep(nanoseconds: 20_000_000)
            } else {
                return
            }
        }
    }

    // MARK: autoStart

    func testAutoStartNoCredentialBecomesUnauthenticated() async {
        let backend = FakeTailnetBackend(outcome: .online(ip4: "100.64.0.1", ip6: nil))
        let node = makeNode(backend)
        node.autoStart()
        XCTAssertEqual(node.state, .unauthenticated)
        let calls = await backend.callCount()
        XCTAssertEqual(calls, 0)
    }

    func testAutoStartWithPersistedStateRecoversWithoutKey() async throws {
        try seedState()
        let backend = FakeTailnetBackend(outcome: .online(ip4: "100.64.0.10", ip6: "fd7a::1"))
        let node = makeNode(backend)
        node.autoStart()
        await waitForSettle(node)

        if case .online(let ip4, let ip6) = node.state {
            XCTAssertEqual(ip4, "100.64.0.10")
            XCTAssertEqual(ip6, "fd7a::1")
        } else {
            return XCTFail("期望 online，实际 \(node.state)")
        }
        let call = await backend.lastCall()
        XCTAssertNil(call?.authKey, "有历史态时恢复必须 authKey=nil（凭据在状态目录）")
        XCTAssertEqual(call?.stateDir, tempDir.path)
        XCTAssertEqual(call?.hostName, "dsh-ipad")
    }

    func testAutoStartWithKeyButNoStateBringsKey() async throws {
        auth.key = "tskey-auth-cold"
        let backend = FakeTailnetBackend(outcome: .online(ip4: "100.64.0.11", ip6: nil))
        let node = makeNode(backend)
        node.autoStart()
        await waitForSettle(node)

        let call = await backend.lastCall()
        XCTAssertEqual(call?.authKey, "tskey-auth-cold", "无历史态但 Keychain 有 key：带 key 重入网")
        if case .online = node.state {} else {
            return XCTFail("期望 online，实际 \(node.state)")
        }
    }

    func testAutoStartIsIdempotentAfterOnline() async {
        auth.key = "tskey-x"
        let queue = BackendQueue()
        queue.append(FakeTailnetBackend(outcome: .online(ip4: "1.1.1.1", ip6: nil)))
        let node = makeNodeQueue(queue)
        node.autoStart()
        await waitForSettle(node)

        // 已离开 idle：再次 autoStart 不得新建第二个后端（守卫 state == .idle）。
        node.autoStart()
        XCTAssertEqual(queue.createdCount(), 1)
    }

    // MARK: signIn

    func testSignInBlankKeyFailsWithoutBackend() async {
        let backend = FakeTailnetBackend(outcome: .online(ip4: "1.1.1.1", ip6: nil))
        let node = makeNode(backend)
        await node.signIn(authKey: "  \n ")
        if case .failed(let reason) = node.state {
            XCTAssertEqual(reason, "auth key 为空")
        } else {
            return XCTFail("期望 failed，实际 \(node.state)")
        }
        XCTAssertNil(auth.key, "空 key 不得写入 Keychain")
        let calls = await backend.callCount()
        XCTAssertEqual(calls, 0, "空 key 不得拉起后端")
    }

    func testSignInTrimsSavesKeyAndGoesOnlineWithBothIPs() async {
        let backend = FakeTailnetBackend(outcome: .online(ip4: "100.83.159.13",
                                                         ip6: "fd7a:115c::a"))
        let node = makeNode(backend)
        await node.signIn(authKey: "\n tskey-auth-abc \r\n")
        await waitForSettle(node)

        XCTAssertEqual(auth.key, "tskey-auth-abc")
        if case .online(let ip4, let ip6) = node.state {
            XCTAssertEqual(ip4, "100.83.159.13")
            XCTAssertEqual(ip6, "fd7a:115c::a")
        } else {
            return XCTFail("期望 online，实际 \(node.state)")
        }
        let call = await backend.lastCall()
        XCTAssertEqual(call?.authKey, "tskey-auth-abc", "入参 key 应为 trim 后的")
        XCTAssertEqual(call?.stateDir, tempDir.path)
        XCTAssertEqual(call?.hostName, "dsh-ipad")
        XCTAssertTrue(call?.controlURL.hasPrefix("https://") == true,
                      "controlURL 默认必须是官方 https control：\(call?.controlURL ?? "nil")")
    }

    func testOnlineWithOnlyIPv6ShowsDashForIPv4() async {
        let backend = FakeTailnetBackend(outcome: .online(ip4: nil, ip6: "fd7a::9"))
        let node = makeNode(backend)
        await node.signIn(authKey: "tskey-v6only")
        await waitForSettle(node)
        if case .online(let ip4, let ip6) = node.state {
            XCTAssertEqual(ip4, "—")
            XCTAssertEqual(ip6, "fd7a::9")
        } else {
            return XCTFail("期望 online，实际 \(node.state)")
        }
    }

    func testSignInFailureCarriesReasonAndKeepsKeyForRetry() async {
        let backend = FakeTailnetBackend(outcome: .failure(BoomError(message: "401 invalid key")))
        let node = makeNode(backend)
        await node.signIn(authKey: "tskey-bad")
        await waitForSettle(node)

        if case .failed(let reason) = node.state {
            XCTAssertTrue(reason.contains("401 invalid key"), "失败原因应透传：\(reason)")
            XCTAssertFalse(reason.contains("tskey-bad"), "失败原因绝不得包含入参 key")
        } else {
            return XCTFail("期望 failed，实际 \(node.state)")
        }
        XCTAssertEqual(auth.key, "tskey-bad", "失败后 Keychain 凭据保留，供 retry 重连")
    }

    func testSignInUpSucceedsButNoAddressesFails() async {
        let backend = FakeTailnetBackend(outcome: .noAddresses)
        let node = makeNode(backend)
        await node.signIn(authKey: "tskey-noip")
        await waitForSettle(node)
        if case .failed(let reason) = node.state {
            XCTAssertTrue(reason.contains("未取得 tailnet 地址"))
        } else {
            return XCTFail("期望 failed(无地址)，实际 \(node.state)")
        }
    }

    // MARK: retry

    func testRetryAfterFailureUsesStoredKey() async {
        let queue = BackendQueue()
        queue.append(FakeTailnetBackend(outcome: .failure(BoomError(message: "network down"))))
        queue.append(FakeTailnetBackend(outcome: .online(ip4: "100.64.0.20", ip6: nil)))
        let node = makeNodeQueue(queue)

        await node.signIn(authKey: "tskey-retry")
        await waitForSettle(node)
        if case .failed = node.state {} else {
            return XCTFail("前置：期望 failed，实际 \(node.state)")
        }
        await node.retry()
        await waitForSettle(node)

        if case .online(let ip4, _) = node.state {
            XCTAssertEqual(ip4, "100.64.0.20")
        } else {
            return XCTFail("retry 后期望 online，实际 \(node.state)")
        }
        let retryCall = await queue.backend(at: 1).lastCall()
        XCTAssertEqual(retryCall?.authKey, "tskey-retry", "无历史态时 retry 用 Keychain 里的 key")
    }

    func testRetryWithPersistedStateUsesNilKey() async throws {
        try seedState()
        let queue = BackendQueue()
        queue.append(FakeTailnetBackend(outcome: .failure(BoomError(message: "DERP timeout"))))
        queue.append(FakeTailnetBackend(outcome: .online(ip4: "100.64.0.21", ip6: nil)))
        let node = makeNodeQueue(queue)

        node.autoStart()
        await waitForSettle(node)
        await node.retry()
        await waitForSettle(node)

        if case .online = node.state {} else {
            return XCTFail("期望 online，实际 \(node.state)")
        }
        let retryCall = await queue.backend(at: 1).lastCall()
        XCTAssertNil(retryCall?.authKey, "有历史态时 retry 必须 authKey=nil")
    }

    // MARK: signOut / wipeState

    func testSignOutShutsDownDeletesKeyAndGoesUnauthenticated() async {
        let backend = FakeTailnetBackend(outcome: .online(ip4: "100.64.0.1", ip6: nil))
        let node = makeNode(backend)
        await node.signIn(authKey: "tskey-out")
        await waitForSettle(node)

        await node.signOut()
        XCTAssertEqual(node.state, .unauthenticated)
        XCTAssertNil(auth.key)
        let shutdowns = await backend.shutdowns()
        XCTAssertEqual(shutdowns, 1)
    }

    func testWipeStateDeletesStateDirectory() async throws {
        try seedState()
        XCTAssertTrue(FileManager.default.fileExists(atPath: tempDir.path))
        let backend = FakeTailnetBackend(outcome: .online(ip4: "100.64.0.1", ip6: nil))
        let node = makeNode(backend)
        node.autoStart()
        await waitForSettle(node)

        await node.wipeState()
        XCTAssertEqual(node.state, .unauthenticated)
        XCTAssertNil(auth.key)
        XCTAssertFalse(FileManager.default.fileExists(atPath: tempDir.path),
                       "wipeState 必须删除节点状态目录")
    }

    // MARK: starting 守卫

    func testSecondSignInWhileStartingIsIgnored() async throws {
        let backend = FakeTailnetBackend(outcome: .hang)
        let node = makeNode(backend)

        Task { await node.signIn(authKey: "tskey-a") }
        await waitForStarting(node)

        // starting 中第二次提交：直接被守卫忽略，不新建后端、不替换凭据。
        await node.signIn(authKey: "tskey-b")
        XCTAssertEqual(auth.key, "tskey-a", "守卫命中时第二个 key 不得覆盖已存凭据")
        let calls = await backend.callCount()
        XCTAssertEqual(calls, 1)
        if case .starting = node.state {} else {
            return XCTFail("期望仍在 starting，实际 \(node.state)")
        }

        // 收尾：释放挂起 → online → signOut 中断孤立 Task。
        await backend.releaseHang(outcome: .online(ip4: "100.64.0.30", ip6: nil))
        await waitForSettle(node)
        await node.signOut()
    }

    func testRetryWhileStartingIsIgnored() async throws {
        let backend = FakeTailnetBackend(outcome: .hang)
        let node = makeNode(backend)

        Task { await node.signIn(authKey: "tskey-a") }
        await waitForStarting(node)
        await node.retry()
        let calls = await backend.callCount()
        XCTAssertEqual(calls, 1)

        await backend.releaseHang(outcome: .online(ip4: "100.64.0.31", ip6: nil))
        await waitForSettle(node)
        await node.signOut()
    }

    // MARK: 3.5 弱网看门狗 / 取消（真机 starting 锁死缺陷的回归测试）

    func testWatchdogTimesOutHangAndShowsTimeoutFailure() async throws {
        try seedState()
        let backend = FakeTailnetBackend(outcome: .hang)
        let node = makeNode(backend, bringUpTimeout: 0.3)

        node.autoStart()
        await waitForStarting(node)
        await waitForFailed(node)

        if case .failed(let reason) = node.state {
            XCTAssertTrue(reason.contains("超时"), "弱网挂起必须上屏超时原因，实际：\(reason)")
        } else {
            return XCTFail("看门狗到期期望 failed，实际 \(node.state)")
        }
        let calls = await backend.callCount()
        XCTAssertEqual(calls, 1, "超时不得重试点燃第二次 bringUp")
        let shutdowns = await backend.shutdowns()
        XCTAssertEqual(shutdowns, 1, "看门狗必须 down() 打断阻塞中的 up")
        XCTAssertFalse(node.recentLogs.isEmpty, "超时过程应写入内存日志，供设置页排查")
    }

    func testCancelBringUpReturnsToUnauthenticatedAndAllowsResignIn() async throws {
        let queue = BackendQueue()
        queue.append(FakeTailnetBackend(outcome: .hang))
        queue.append(FakeTailnetBackend(outcome: .online(ip4: "100.64.0.40", ip6: nil)))
        let node = makeNodeQueue(queue)

        Task { await node.signIn(authKey: "tskey-a") }
        await waitForStarting(node)

        await node.cancelBringUp()
        XCTAssertEqual(node.state, .unauthenticated, "取消后应回未认证态，不再死锁在 starting")
        let firstShutdowns = await queue.backend(at: 0).shutdowns()
        XCTAssertEqual(firstShutdowns, 1, "取消必须 down() 打断第一次挂起的 up")

        // 旧回调以 CancellationError 落地，但 generation 已作废：不得覆盖状态。
        await waitForSettle(node)
        XCTAssertEqual(node.state, .unauthenticated, "旧 bringUp 的迟到结果必须被丢弃")

        // 取消后可立即用新 key 重入网，走第二个后端。
        await node.signIn(authKey: "tskey-b")
        await waitForSettle(node)
        if case .online(let ip4, _) = node.state {
            XCTAssertEqual(ip4, "100.64.0.40")
        } else {
            return XCTFail("取消后重入期望 online，实际 \(node.state)")
        }
        let secondCall = await queue.backend(at: 1).lastCall()
        XCTAssertEqual(secondCall?.authKey, "tskey-b")

        await node.signOut()
    }

    // MARK: 4.1 localhost 反代装配（真 NWListener 绑 127.0.0.1，不经 tailnet dial）

    /// online 且后端给出 handle：桥自动起、base 落 UserDefaults；signOut 后桥停。
    func testOnlineWithHandleStartsBridgeAndSignOutStopsIt() async {
        UserDefaults.standard.removeObject(forKey: LoopbackProxy.baseURLDefaultsKey)
        defer { UserDefaults.standard.removeObject(forKey: LoopbackProxy.baseURLDefaultsKey) }

        let backend = FakeTailnetBackend(outcome: .online(ip4: "100.64.0.50", ip6: nil),
                                         handle: 42)
        let node = makeNode(backend)
        await node.signIn(authKey: "tskey-bridge")
        await waitForSettle(node)
        await waitForBridge(node)

        guard case .running(let base) = node.bridge else {
            return XCTFail("期望桥 .running，实际 \(node.bridge)")
        }
        XCTAssertTrue(base.hasPrefix("http://127.0.0.1:"), "桥 base 必须是 loopback：\(base)")
        XCTAssertEqual(UserDefaults.standard.string(forKey: LoopbackProxy.baseURLDefaultsKey),
                       base, "起桥必须把 base 落 UserDefaults 供 WKWebView 读取")
        let dials = await backend.dialHandleCalls
        XCTAssertEqual(dials, 1, "起桥必须且只取一次 tailscale handle")

        // 桥只 bind 监听，未收到连接不应触发真实 tailscale_dial（connecter 在每连接时才 dial）。
        await node.signOut()
        guard case .stopped = node.bridge else {
            return XCTFail("signOut 后期望桥 .stopped，实际 \(node.bridge)")
        }
    }

    /// online 但后端给不出 handle：节点仍在线，桥进 .failed 且给出人类可读原因。
    func testOnlineWithoutHandleFailsBridgeButNodeStaysOnline() async {
        let backend = FakeTailnetBackend(outcome: .online(ip4: "100.64.0.51", ip6: nil),
                                         handle: nil)
        let node = makeNode(backend)
        await node.signIn(authKey: "tskey-nohandle")
        await waitForSettle(node)
        await waitForBridge(node)

        if case .online(let ip4, _) = node.state {
            XCTAssertEqual(ip4, "100.64.0.51")
        } else {
            return XCTFail("桥失败不应拖垮节点，期望 online，实际 \(node.state)")
        }
        guard case .failed(let reason) = node.bridge else {
            return XCTFail("期望桥 .failed，实际 \(node.bridge)")
        }
        XCTAssertTrue(reason.contains("handle"), "失败原因应指向 handle 缺失：\(reason)")
        let dials = await backend.dialHandleCalls
        XCTAssertEqual(dials, 1)
    }
}
