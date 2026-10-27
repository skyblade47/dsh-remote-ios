import Foundation
import Security

// ============================================================================
// Phase 3.2 —— Tailscale 入网 auth key 的唯一存放处（Keychain）。
//
// 安全纪律：
//   ① auth key 只用不存盘——这里是**唯一例外**，且只进 Keychain（kSecClassGenericPassword，
//      this-device-only、不进 iCloud 钥匙串、不参与备份导出）；绝不落 UserDefaults/文件/日志。
//   ② 任何读取结果不得回显到 UI（3.3 设置页用 SecureField，只写不读显）。
//   ③ 登出/清除走 delete()；删 Keychain item 与节点状态目录由调用方编排。
//
// 可测试性（3.4）：控制器只依赖 AuthKeyStoring 协议，状态机单测注入内存替身；
// TailnetAuthStore 自身的 trim/覆盖/幂等删除等逻辑通过注入 KeychainBackending
// 替身测试（CI 模拟器逻辑测试宿主无 keychain-access-groups，SecItemAdd 会 -34018）。
// ============================================================================

protocol AuthKeyStoring: AnyObject {
    /// 取已存 key；无 item / 读取失败均返回 nil（失败不抛，按"未入网"处理）。
    func loadAuthKey() -> String?
    /// 覆盖写入（空串等同未存）。返回是否成功；失败原因仅给 OSStatus，不含 key 内容。
    @discardableResult
    func saveAuthKey(_ key: String) -> Bool
    /// 删除 item（无 item 也视为成功）。
    @discardableResult
    func deleteAuthKey() -> Bool
    /// 是否已存（3.3 UI 据此显示"已入网凭据"态，不返回明文）。
    func hasAuthKey() -> Bool
}

/// Keychain 读写的最小后端面：四个 SecItem C API 的可替换封装。
/// 生产用 SecItemBackend；3.4 测试注入内存实现绕开模拟器 entitlement 限制。
protocol KeychainBackending {
    /// 复制匹配 item；status != errSecSuccess 时 item 为 nil。
    func itemCopyMatching(_ query: [String: Any]) -> (status: OSStatus, item: CFTypeRef?)
    /// 更新匹配 item。
    func itemUpdate(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus
    /// 新增 item。
    func itemAdd(_ attributes: [String: Any]) -> OSStatus
    /// 删除匹配 item。
    func itemDelete(_ query: [String: Any]) -> OSStatus
}

/// 生产后端：直接透传 Security.framework C API。
struct SecItemBackend: KeychainBackending {
    func itemCopyMatching(_ query: [String: Any]) -> (status: OSStatus, item: CFTypeRef?) {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        return (status, item)
    }
    func itemUpdate(_ query: [String: Any], _ attributes: [String: Any]) -> OSStatus {
        SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
    }
    func itemAdd(_ attributes: [String: Any]) -> OSStatus {
        SecItemAdd(attributes as CFDictionary, nil)
    }
    func itemDelete(_ query: [String: Any]) -> OSStatus {
        SecItemDelete(query as CFDictionary)
    }
}

/// Keychain 实现：单条 generic password，account 固定。
final class TailnetAuthStore: AuthKeyStoring {
    /// 固定服务/账号标识：不含任何个人字面量。
    private let service: String
    private let account: String
    private let keychain: KeychainBackending

    init(service: String = "com.skyblade47.dshremote.tailnet",
         account: String = "tsnet-auth-key",
         keychain: KeychainBackending = SecItemBackend()) {
        self.service = service
        self.account = account
        self.keychain = keychain
    }

    func loadAuthKey() -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        let result = keychain.itemCopyMatching(query)
        guard result.status == errSecSuccess,
              let data = result.item as? Data,
              let key = String(data: data, encoding: .utf8),
              !key.isEmpty else {
            return nil
        }
        return key
    }

    func saveAuthKey(_ key: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        let data = Data(trimmed.utf8)
        let base = baseQuery
        let updates: [String: Any] = [kSecValueData as String: data]

        // 先 SecItemUpdate（item 已存在）；不存在再 Add。
        let updateStatus = keychain.itemUpdate(base, updates)
        if updateStatus == errSecSuccess { return true }
        guard updateStatus == errSecItemNotFound else { return false }

        var add = base
        add[kSecValueData as String] = data
        // 仅本机、不可恢复导出；不要求设备解锁（tsnet 后台恢复时进程可能在锁态运行）。
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return keychain.itemAdd(add) == errSecSuccess
    }

    func deleteAuthKey() -> Bool {
        let status = keychain.itemDelete(baseQuery)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    func hasAuthKey() -> Bool {
        var query = baseQuery
        query[kSecReturnData as String] = false
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        return keychain.itemCopyMatching(query).status == errSecSuccess
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
