import Foundation
import TailscaleKit

// Phase 2.1 spike 探针（非产品代码）：
// 目的只有一个——让 app 二进制**真正链接** TailscaleKit（内含 ~21MB Go c-archive），
// 使 CI 产出的未签名 ipa 能回答最高优先未知：免费 Apple ID 能否侧载含 Go 静态库的包。
//
// 这里只引用 iOS 17 可用的纯符号（global let / 无可用性限制的 enum），**不构造
// TailscaleNode、不碰 auth key、不入网**——入网是非交互的 Phase 2.2。
// TailscaleKit 经 magic bytes 取证为 MH_DYLIB（动态框架），embed 进 .app/Frameworks/；
// 对这些符号的引用在主二进制生成 LC_LOAD_DYLIB 加载命令，本文件同时在编译期验证
// 「本仓 Swift 工具链能消费 TailscaleKit 的 swiftinterface」。
enum TailscaleSpikeLinkProbe {
    // 引用即产生对 TailscaleKit 模块符号的链接依赖。
    static let controlURL = kDefaultControlURL
    static let dialProto = NetProtocol.tcp.rawValue
}
