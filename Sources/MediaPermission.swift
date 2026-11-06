import Foundation
import WebKit

// ============================================================================
// 语音（方案 E-iOS / spec §7.1）媒体采集授权决策
//
// WKUIDelegate.webView(_:requestMediaCapturePermissionFor:origin:...) 回调的公开签名
// **不携带 WKMediaCaptureType**，原生侧无法区分这是麦克风还是相机请求。因此这里的决策
// 只做一件事：把请求 origin 与当前实际装载的受信 origin（①内嵌 localhost 反代 /
// ③用户自配 Funnel https 网关）做严格三元组（scheme/host/port）比对，命中才授予。
//
// 安全姿态：
//   - 状态页（dsh-action:/about:blank 等）没有任何装载 origin ⇒ 白名单为 nil ⇒ 拒绝；
//   - 壳内唯一媒体采集方是内核语音插件，仅发起 getUserMedia({audio})，全仓无视频约束；
//   - 系统级麦克风 TCC 弹窗仍由 WebKit 在首次 grant 后自行触发（需 Info.plist 的
//     NSMicrophoneUsageDescription，否则进程直接被判负）。
// ============================================================================

/// 归一化后的 origin 三元组。port 缺省（协议默认端口/URL 未带端口）归一为 0。
struct MediaOrigin: Equatable {
    let scheme: String
    let host: String
    let port: Int

    init(scheme: String, host: String, port: Int) {
        // WKSecurityOrigin 实测给小写；这里再固化一次归一，保证比对不被大小写击穿。
        self.scheme = scheme.lowercased()
        self.host = host.lowercased()
        self.port = port
    }

    /// 从 URL 构造；无 host（自定义 scheme 状态页等）返回 nil。
    init?(url: URL) {
        guard let host = url.host, !host.isEmpty, let scheme = url.scheme else { return nil }
        self.init(scheme: scheme, host: host, port: url.port ?? 0)
    }

    /// 从 URL 字符串构造；解析失败或无 host 返回 nil。
    init?(urlString: String) {
        guard let url = URL(string: urlString) else { return nil }
        self.init(url: url)
    }
}

enum MediaPermission {
    /// 纯函数：origin 命中 localhost 反代白名单或 Funnel https 白名单才 grant，其余 deny。
    /// 两个白名单分别对应 ShellWebView.Coordinator 的 loadedBase / loadedFunnel。
    static func decision(
        origin: MediaOrigin,
        allowedLocalhost: MediaOrigin?,
        allowedFunnel: MediaOrigin?
    ) -> WKPermissionDecision {
        if let allowedLocalhost, origin == allowedLocalhost { return .grant }
        if let allowedFunnel, origin == allowedFunnel { return .grant }
        return .deny
    }
}
