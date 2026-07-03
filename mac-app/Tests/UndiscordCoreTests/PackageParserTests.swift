import XCTest
@testable import UndiscordCore

final class PackageParserTests: XCTestCase {

    func testCsvFirstColumnHandlesQuotesAndNewlines() {
        let csv = """
        ID,Timestamp,Contents,Attachments
        123,2020-01-01,"hello, world",
        456,2020-01-02,"line one
        line two",
        789,2020-01-03,plain,
        """
        XCTAssertEqual(PackageParser.parseCsvFirstColumn(csv), ["123", "456", "789"])
    }

    func testCsvDropsHeaderAndNonNumeric() {
        let csv = "ID,Contents\nabc,skip me\n42,keep\n"
        XCTAssertEqual(PackageParser.parseCsvFirstColumn(csv), ["42"])
    }

    func testParseExtractsDmsAndGroupsButNotGuildChannels() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("undtest-\(UUID().uuidString)")
        let msgs = root.appendingPathComponent("messages")
        try fm.createDirectory(at: msgs, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }

        let index: [String: String] = [
            "111": "Direct Message with Alice",
            "222": "My Group",
            "333": "general in Server",
        ]
        try JSONSerialization.data(withJSONObject: index).write(to: msgs.appendingPathComponent("index.json"))

        func makeChannel(_ id: String, _ type: Int, recipients: [String], ids: [String]) throws {
            let dir = msgs.appendingPathComponent("c\(id)")
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            let ch: [String: Any] = ["id": id, "type": type, "recipients": recipients]
            try JSONSerialization.data(withJSONObject: ch).write(to: dir.appendingPathComponent("channel.json"))
            let arr = ids.map { ["ID": $0, "Timestamp": "2020", "Contents": "x"] }
            try JSONSerialization.data(withJSONObject: arr).write(to: dir.appendingPathComponent("messages.json"))
        }
        try makeChannel("111", 1, recipients: ["alice"], ids: ["1", "2"])
        try makeChannel("222", 3, recipients: ["a", "b"], ids: ["3"])
        try makeChannel("333", 0, recipients: [], ids: ["4"]) // guild channel → excluded

        let parsed = try PackageParser.parse(root: root).sorted { $0.channelId < $1.channelId }
        XCTAssertEqual(parsed.count, 2)
        XCTAssertEqual(parsed[0].channelId, "111")
        XCTAssertEqual(parsed[0].type, 1)
        XCTAssertEqual(parsed[0].label, "Direct Message with Alice")
        XCTAssertEqual(parsed[0].messageIds, ["1", "2"])
        XCTAssertEqual(parsed[1].channelId, "222")
        XCTAssertEqual(parsed[1].type, 3)
        XCTAssertEqual(parsed[1].messageIds, ["3"])
    }

    func testParseReadsCsvChannels() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("undtest-\(UUID().uuidString)")
        let msgs = root.appendingPathComponent("messages")
        let dir = msgs.appendingPathComponent("c999")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }

        try JSONSerialization.data(withJSONObject: ["999": "DM"]).write(to: msgs.appendingPathComponent("index.json"))
        try JSONSerialization.data(withJSONObject: ["id": "999", "type": 1, "recipients": ["x"]])
            .write(to: dir.appendingPathComponent("channel.json"))
        try "ID,Contents\n5,a\n6,b\n".write(to: dir.appendingPathComponent("messages.csv"), atomically: true, encoding: .utf8)

        let parsed = try PackageParser.parse(root: root)
        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(parsed[0].messageIds, ["5", "6"])
    }

    func testParseLocalizedMessagesFolderWithoutIndex() throws {
        // Spanish package: folder is "Mensajes", nested under package/, and there is no
        // index.json (newer exports omit it). Channel folders use the "c<id>" prefix.
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("undtest-\(UUID().uuidString)")
        let msgs = root.appendingPathComponent("package/Mensajes")
        try fm.createDirectory(at: msgs, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }

        let dir = msgs.appendingPathComponent("c228236573370482688")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: ["id": "228236573370482688", "type": 1, "recipients": ["suso"]])
            .write(to: dir.appendingPathComponent("channel.json"))
        try JSONSerialization.data(withJSONObject: [["ID": "9001"], ["ID": "9002"]])
            .write(to: dir.appendingPathComponent("messages.json"))

        XCTAssertEqual(PackageParser.findMessagesDir(root)?.lastPathComponent, "Mensajes")
        let parsed = try PackageParser.parse(root: root)
        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(parsed[0].channelId, "228236573370482688")
        XCTAssertEqual(parsed[0].type, 1)
        XCTAssertEqual(parsed[0].messageIds, ["9001", "9002"])
        XCTAssertEqual(parsed[0].label, "DM 228236573370482688") // no index.json → fallback label
    }

    func testFindMessagesDirWhenUserPicksMessagesFolderDirectly() throws {
        // User selects the localized messages folder itself (no index.json).
        let fm = FileManager.default
        let msgs = fm.temporaryDirectory.appendingPathComponent("Mensajes-\(UUID().uuidString)")
        let dir = msgs.appendingPathComponent("c1")
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: msgs) }
        try JSONSerialization.data(withJSONObject: ["id": "1", "type": 1, "recipients": []])
            .write(to: dir.appendingPathComponent("channel.json"))
        XCTAssertEqual(PackageParser.findMessagesDir(msgs)?.lastPathComponent, msgs.lastPathComponent)
    }

    func testParseCurrentFormatStringTypesAndNumericIds() throws {
        // Real 2024+ package: channel type is a string ("DM"/"GROUP_DM"/"GUILD_TEXT"),
        // message IDs are JSON numbers (19-digit snowflakes), no index.json.
        let fm = FileManager.default
        let msgs = fm.temporaryDirectory.appendingPathComponent("Mensajes-\(UUID().uuidString)")
        try fm.createDirectory(at: msgs, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: msgs) }

        func makeChannel(_ id: String, _ type: String, ids: [Int64]) throws {
            let dir = msgs.appendingPathComponent("c\(id)")
            try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            try JSONSerialization.data(withJSONObject: ["id": id, "type": type, "recipients": ["r1"]])
                .write(to: dir.appendingPathComponent("channel.json"))
            let arr = ids.map { ["ID": NSNumber(value: $0), "Timestamp": "2024", "Contents": "x"] }
            try JSONSerialization.data(withJSONObject: arr).write(to: dir.appendingPathComponent("messages.json"))
        }
        try makeChannel("1245447521413890052", "DM", ids: [1253795966566535298])
        try makeChannel("2000000000000000000", "GROUP_DM", ids: [3, 4])
        try makeChannel("879733469452836864", "GUILD_TEXT", ids: [9]) // guild → excluded

        let parsed = try PackageParser.parse(root: msgs).sorted { $0.channelId < $1.channelId }
        XCTAssertEqual(parsed.count, 2)
        XCTAssertEqual(parsed[0].type, 1)
        XCTAssertEqual(parsed[0].messageIds, ["1253795966566535298"]) // 19-digit id kept exactly
        XCTAssertEqual(parsed[1].type, 3)
        XCTAssertEqual(parsed[1].messageIds, ["3", "4"])
    }

    func testNormalizeTypeAcceptsStringsAndInts() {
        XCTAssertEqual(PackageParser.normalizeType("DM"), 1)
        XCTAssertEqual(PackageParser.normalizeType("GROUP_DM"), 3)
        XCTAssertEqual(PackageParser.normalizeType("GUILD_TEXT"), 0)
        XCTAssertEqual(PackageParser.normalizeType(1), 1)
        XCTAssertEqual(PackageParser.normalizeType(3), 3)
        XCTAssertEqual(PackageParser.normalizeType("nope"), -1)
        XCTAssertEqual(PackageParser.normalizeType(nil), -1)
    }

    func testMissingMessagesIndexThrows() {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("empty-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        XCTAssertThrowsError(try PackageParser.parse(root: root))
    }
}
