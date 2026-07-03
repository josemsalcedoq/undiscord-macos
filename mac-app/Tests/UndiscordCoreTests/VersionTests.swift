import XCTest
@testable import UndiscordCore

final class VersionTests: XCTestCase {
    func testParsing() {
        XCTAssertEqual(Version("v0.2.0"), Version(0, 2, 0))
        XCTAssertEqual(Version("0.2.0"), Version(0, 2, 0))
        XCTAssertEqual(Version("V1.2"), Version(1, 2, 0))
        XCTAssertEqual(Version("2"), Version(2, 0, 0))
        XCTAssertEqual(Version("0.2.0-beta.1"), Version(0, 2, 0))
        XCTAssertEqual(Version("  v1.4.9 "), Version(1, 4, 9))
    }

    func testOrdering() {
        XCTAssertTrue(Version("0.2.0") > Version("0.1.0"))
        XCTAssertTrue(Version("v0.2.0") > Version("v0.1.9"))
        XCTAssertTrue(Version("1.0.0") > Version("0.9.9"))
        XCTAssertTrue(Version("0.2.1") > Version("0.2.0"))
        XCTAssertFalse(Version("0.2.0") > Version("0.2.0"))
        XCTAssertFalse(Version("0.1.0") > Version("0.2.0"))
    }

    func testUpdateDetection() {
        // latest > current  => update available
        XCTAssertTrue(Version("v0.3.0") > Version("0.2.0"))
        // latest == current => no update
        XCTAssertFalse(Version("v0.2.0") > Version("0.2.0"))
    }
}
