import Foundation

// ============================================================================
// 壳文档 origin 选择 —— 本地优先架构的关键
//
// 主壳 shell.html 永远用 loadHTMLString 从 Bundle 直达（零网络首发），但文档需要一个
// baseURL 来决定其 origin：
//   · 已配置合法 https 网关 ⇒ 借用网关 origin。这样壳内 [DSH] iframe 的同源 /app#/
//     才能通过网关 CSP `frame-ancestors 'self'`，Cookie 也同源（等效 PC 的回环反代）。
//   · 未配置 / 非法 / 离线 ⇒ 固定占位 https origin（.invalid TLD 保证永不解析为真实主机）。
//     此时本地写作页完全可用；/app#/ 与 /api 的网络请求会失败，writing.js 本就设计为
//     「网络失败→留本地草稿/不阻塞」，故离线写作语义天然成立。
//
// 为什么必须是 https 形态的占位：网关 frame-ancestors 与混合内容策略都按 https 口径，
// 用一个 https 占位 origin 可让"未配置→配置后重建"两条路径的同源判断保持同一形状。
// ============================================================================

enum ShellOrigin {
    /// 未配置网关时的固定占位 origin（无路径、保留尾斜杠以便直接当 baseURL 用）。
    static let placeholder = "https://local.dsh-remote.invalid/"

    /// 解析壳文档应使用的 origin 字符串（始终返回可用值，不抛错）。
    static func resolve(gatewayRaw: String) -> String {
        guard let origin = try? GatewayURL.normalize(gatewayRaw) else {
            return placeholder
        }
        return origin
    }

    /// 供 loadHTMLString(baseURL:) 使用的 URL；理论上不会失败（两路都是合法 https URL）。
    static func baseURL(gatewayRaw: String) -> URL {
        URL(string: resolve(gatewayRaw: gatewayRaw)) ?? URL(string: placeholder)!
    }
}
