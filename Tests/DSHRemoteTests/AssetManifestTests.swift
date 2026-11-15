import XCTest
@testable import DSHRemote

final class AssetManifestTests: XCTestCase {
    func testWhitelistContainsTwentyOneAssets() {
        XCTAssertEqual(AssetManifest.names.count, 21)
        XCTAssertTrue(AssetManifest.isAsset("writing-count-core.js"))
        XCTAssertTrue(AssetManifest.isAsset("sensitive-words.js"))
        XCTAssertTrue(AssetManifest.isAsset("sensitive.js"))
        XCTAssertTrue(AssetManifest.isAsset("search-core.js"))
        XCTAssertTrue(AssetManifest.isAsset("ipad.css"))
        XCTAssertTrue(AssetManifest.isAsset("ipad.js"))
        // 悬浮流式对话三件套（2026-11-15 自 PC writing-client 移植）
        XCTAssertTrue(AssetManifest.isAsset("coach-chat-core.js"))
        XCTAssertTrue(AssetManifest.isAsset("coach-chat-net.js"))
        XCTAssertTrue(AssetManifest.isAsset("coach-chat-boot.js"))
    }

    func testContentTypeByExtension() {
        XCTAssertEqual(AssetManifest.contentType("writing.js"), "text/javascript; charset=utf-8")
        XCTAssertEqual(AssetManifest.contentType("writing.css"), "text/css; charset=utf-8")
        XCTAssertEqual(AssetManifest.contentType("ping"), "application/json; charset=utf-8")
        XCTAssertEqual(AssetManifest.contentType("x.bin"), "application/octet-stream")
    }

    func testPingIsNotABundleAsset() {
        XCTAssertFalse(AssetManifest.isAsset("ping"))
        XCTAssertTrue(AssetManifest.isAsset("writing.js"))
        XCTAssertFalse(AssetManifest.isAsset("../writing.js"))
    }
}
