import XCTest
@testable import DSHRemote

final class AssetManifestTests: XCTestCase {
    func testWhitelistContainsElevenAssets() {
        XCTAssertEqual(AssetManifest.names.count, 11)
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
