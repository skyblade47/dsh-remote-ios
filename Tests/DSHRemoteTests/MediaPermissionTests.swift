import XCTest
import WebKit
@testable import DSHRemote

// spec §7.1（方案 E-iOS）：WKUIDelegate 媒体采集回调只对白名单 origin（①localhost 反代 /
// ③Funnel https）授予，其余 origin 拒绝。纯函数决策脱离 WKWebView，模拟器单测覆盖全分支。
//
// 🔴 API 现实注记：WKUIDelegate.webView(_:requestMediaCapturePermissionFor:...) 的公开签名
//    不携带 WKMediaCaptureType，原生侧无法区分麦克风/相机请求，spec §7.1「相机默认 deny」的
//    类型约束在公开 API 下不可直接判定。实际安全姿态由两点保证：
//    ① 仅对两个受信自有 origin（内嵌 localhost 反代 / 用户自配 Funnel 网关）授予；
//    ② 壳内唯一采集方是内核语音插件，只发 getUserMedia({audio})，全仓无视频采集约束。
final class MediaPermissionTests: XCTestCase {

    // MARK: 白名单构造

    private let localhost = MediaOrigin(scheme: "http", host: "127.0.0.1", port: 38123)
    private let funnel = MediaOrigin(scheme: "https", host: "dsh-cloud.tail7bd3dd.ts.net", port: 0)

    // MARK: 白名单 origin ⇒ grant

    func testLocalhostOriginGranted() {
        XCTAssertEqual(
            MediaPermission.decision(
                origin: localhost,
                allowedLocalhost: localhost, allowedFunnel: nil),
            .grant)
    }

    func testFunnelHttpsOriginGranted() {
        XCTAssertEqual(
            MediaPermission.decision(
                origin: funnel,
                allowedLocalhost: localhost, allowedFunnel: funnel),
            .grant)
    }

    // MARK: 非白名单 origin ⇒ deny

    func testUnknownOriginDenied() {
        let evil = MediaOrigin(scheme: "https", host: "evil.example.com", port: 0)
        XCTAssertEqual(
            MediaPermission.decision(
                origin: evil,
                allowedLocalhost: localhost, allowedFunnel: funnel),
            .deny)
    }

    func testLocalhostWrongPortDenied() {
        let otherPort = MediaOrigin(scheme: "http", host: "127.0.0.1", port: 9999)
        XCTAssertEqual(
            MediaPermission.decision(
                origin: otherPort,
                allowedLocalhost: localhost, allowedFunnel: nil),
            .deny)
    }

    func testLocalhostWrongHostDenied() {
        // 同样是 loopback 段但 host 字面量不同（localhost vs 127.0.0.1）：不放宽，严格三元组比对。
        let named = MediaOrigin(scheme: "http", host: "localhost", port: 38123)
        XCTAssertEqual(
            MediaPermission.decision(
                origin: named,
                allowedLocalhost: localhost, allowedFunnel: nil),
            .deny)
    }

    func testPlainHttpFunnelOriginDenied() {
        // Funnel 只接受 https；若 origin 退化成 http 明文，scheme 三元组不等，必须拒绝。
        let plain = MediaOrigin(scheme: "http", host: "dsh-cloud.tail7bd3dd.ts.net", port: 0)
        XCTAssertEqual(
            MediaPermission.decision(
                origin: plain,
                allowedLocalhost: localhost, allowedFunnel: funnel),
            .deny)
    }

    // MARK: 白名单缺失（nil）⇒ deny

    func testDeniedWhenNoWhitelistLoaded() {
        XCTAssertEqual(
            MediaPermission.decision(
                origin: localhost,
                allowedLocalhost: nil, allowedFunnel: nil),
            .deny)
    }

    func testFunnelDeniedWhenOnlyLocalhostWhitelisted() {
        XCTAssertEqual(
            MediaPermission.decision(
                origin: funnel,
                allowedLocalhost: localhost, allowedFunnel: nil),
            .deny)
    }

    // MARK: 便利构造：从 URL 字符串 / URL 构造

    func testMediaOriginFromURLString() throws {
        let origin = try XCTUnwrap(MediaOrigin(urlString: "http://127.0.0.1:38123/__shell__/shell.html"))
        XCTAssertEqual(origin.scheme, "http")
        XCTAssertEqual(origin.host, "127.0.0.1")
        XCTAssertEqual(origin.port, 38123)
    }

    func testMediaOriginFromHttpsURLWithoutPortNormalizesToZero() throws {
        let origin = try XCTUnwrap(MediaOrigin(urlString: "https://dsh-cloud.tail7bd3dd.ts.net/app"))
        XCTAssertEqual(origin.scheme, "https")
        XCTAssertEqual(origin.host, "dsh-cloud.tail7bd3dd.ts.net")
        XCTAssertEqual(origin.port, 0)
    }

    func testMediaOriginRejectsStringWithoutHost() {
        XCTAssertNil(MediaOrigin(urlString: "dsh-action:use-emergency"))
    }

    func testMediaOriginFromURL() throws {
        let url = try XCTUnwrap(URL(string: "https://dsh-cloud.tail7bd3dd.ts.net:8443/app"))
        let origin = try XCTUnwrap(MediaOrigin(url: url))
        XCTAssertEqual(origin, MediaOrigin(scheme: "https", host: "dsh-cloud.tail7bd3dd.ts.net", port: 8443))
    }

    func testMediaOriginNormalizesCase() {
        // scheme/host 大小写归一（WKSecurityOrigin 实际给小写，这里固化归一行为）。
        let origin = MediaOrigin(scheme: "HTTP", host: "127.0.0.1", port: 38123)
        XCTAssertEqual(origin, localhost)
    }
}
