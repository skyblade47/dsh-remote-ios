import XCTest
@testable import DSHRemote

// ============================================================================
// Phase 3.4 —— TailnetAuthStore 真实 Keychain 往返（CI 模拟器 keychain 可用）。
// 隔离手段：每个用例独立 service（UUID），tearDown 必删，绝不复用产品 service。
// ============================================================================

final class TailnetAuthStoreTests: XCTestCase {

    var service: String!
    var store: TailnetAuthStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        service = "test.\(UUID().uuidString)"
        store = TailnetAuthStore(service: service, account: "tsnet-auth-key")
        _ = store.deleteAuthKey() // 兜底：同名残留（理论不会有）
    }

    override func tearDownWithError() throws {
        _ = store.deleteAuthKey()
        store = nil
        service = nil
        try super.tearDownWithError()
    }

    func testEmptyKeychainReadsNilAndHasFalse() {
        XCTAssertNil(store.loadAuthKey())
        XCTAssertFalse(store.hasAuthKey())
    }

    func testSaveLoadHasRoundTrip() {
        XCTAssertTrue(store.saveAuthKey("tskey-auth-test-123"))
        XCTAssertEqual(store.loadAuthKey(), "tskey-auth-test-123")
        XCTAssertTrue(store.hasAuthKey())
    }

    func testSaveTrimsWhitespaceAndNewlines() {
        XCTAssertTrue(store.saveAuthKey("  tskey-auth-x\r\n"))
        XCTAssertEqual(store.loadAuthKey(), "tskey-auth-x")
    }

    func testSaveEmptyOrBlankFails() {
        XCTAssertFalse(store.saveAuthKey(""))
        XCTAssertFalse(store.saveAuthKey("   \n\t "))
        XCTAssertNil(store.loadAuthKey())
    }

    func testSecondSaveOverwritesNotDuplicates() {
        XCTAssertTrue(store.saveAuthKey("tskey-auth-first"))
        XCTAssertTrue(store.saveAuthKey("tskey-auth-second"))
        XCTAssertEqual(store.loadAuthKey(), "tskey-auth-second")
    }

    func testDeleteRemovesItemAndIsIdempotent() {
        XCTAssertTrue(store.saveAuthKey("tskey-auth-del"))
        XCTAssertTrue(store.deleteAuthKey())
        XCTAssertFalse(store.hasAuthKey())
        XCTAssertNil(store.loadAuthKey())
        // 无 item 再删也算成功（signOut/wipeState 可重复调）。
        XCTAssertTrue(store.deleteAuthKey())
    }

    func testIndependentServicesDoNotLeak() {
        let other = TailnetAuthStore(service: "test.\(UUID().uuidString)", account: "tsnet-auth-key")
        defer { _ = other.deleteAuthKey() }
        XCTAssertTrue(other.saveAuthKey("tskey-auth-other"))
        XCTAssertNil(store.loadAuthKey(), "不同 service 的 item 不得串读")
    }
}
