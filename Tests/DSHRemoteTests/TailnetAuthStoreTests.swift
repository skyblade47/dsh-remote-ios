import XCTest
import Security
@testable import DSHRemote

// ============================================================================
// Phase 3.4 —— TailnetAuthStore 逻辑测试。
//
// CI 模拟器逻辑测试宿主没有 keychain-access-groups entitlement，真实
// SecItemAdd 会返回 -34018（errSecMissingEntitlement），所以这里注入内存
// KeychainBackending 替身，精确模拟 SecItem 的 Success / itemNotFound 语义，
// 覆盖 TailnetAuthStore 自身逻辑：trim、update-not-found 后 add、二次保存
// 覆盖、删除幂等、空串拒绝、不同 service 隔离。
//
// 生产默认后端（SecItemBackend 直透 Security.framework）由 TailnetNode 3.5
// 真机验收在真 Keychain 上验证（auth key 只用不存盘，Keychain 是唯一例外）。
// ============================================================================

/// 模拟单条 generic password 的内存 Keychain：按 (service, account) 存一条 Data。
private final class FakeKeychain: KeychainBackending {
    private var storage: [String: Data] = [:]

    private func key(for query: [String: Any]) -> String? {
        guard let service = query[kSecAttrService as String] as? String,
              let account = query[kSecAttrAccount as String] as? String else { return nil }
        return "\(service)#\(account)"
    }

    func itemCopyMatching(_ query: [String: Any]) -> (status: OSStatus, item: CFTypeRef?) {
        guard let k = key(for: query), let data = storage[k] else {
            return (errSecItemNotFound, nil)
        }
        // hasAuthKey 只问状态（kSecReturnData=false）：返回 success、item 可为 nil。
        if let returnData = query[kSecReturnData as String] as? Bool, !returnData {
            return (errSecSuccess, nil)
        }
        return (errSecSuccess, data as CFData)
    }

    func itemUpdate(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        guard let k = key(for: query), storage[k] != nil else { return errSecItemNotFound }
        if let data = attributes[kSecValueData as String] as? Data {
            storage[k] = data
        }
        return errSecSuccess
    }

    func itemAdd(_ attributes: [String: Any]) -> OSStatus {
        guard let k = key(for: attributes),
              let data = attributes[kSecValueData as String] as? Data else {
            return errSecParam
        }
        guard storage[k] == nil else { return errSecDuplicateItem }
        storage[k] = data
        return errSecSuccess
    }

    func itemDelete(_ query: [String: Any]) -> OSStatus {
        guard let k = key(for: query) else { return errSecParam }
        if storage.removeValue(forKey: k) == nil { return errSecItemNotFound }
        return errSecSuccess
    }
}

final class TailnetAuthStoreTests: XCTestCase {

    var keychain: FakeKeychain!
    var store: TailnetAuthStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        keychain = FakeKeychain()
        store = TailnetAuthStore(service: "test.\(UUID().uuidString)",
                                 account: "tsnet-auth-key",
                                 keychain: keychain)
    }

    override func tearDownWithError() throws {
        store = nil
        keychain = nil
        try super.tearDownWithError()
    }

    func testEmptyStoreReadsNilAndHasFalse() {
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
        XCTAssertFalse(store.hasAuthKey())
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
        let other = TailnetAuthStore(service: "test.\(UUID().uuidString)",
                                     account: "tsnet-auth-key",
                                     keychain: keychain)
        XCTAssertTrue(other.saveAuthKey("tskey-auth-other"))
        XCTAssertNil(store.loadAuthKey(), "不同 service 的 item 不得串读")
        XCTAssertTrue(other.deleteAuthKey())
    }
}
