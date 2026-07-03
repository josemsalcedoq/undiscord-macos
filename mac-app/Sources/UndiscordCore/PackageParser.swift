import Foundation

/// One conversation extracted from a Discord Data Package.
public struct ParsedChannel: Equatable {
    public let channelId: String
    public let type: Int          // 1 = DM, 3 = group DM
    public let label: String
    public let recipients: [String]
    public let messageIds: [String]

    public init(channelId: String, type: Int, label: String, recipients: [String], messageIds: [String]) {
        self.channelId = channelId
        self.type = type
        self.label = label
        self.recipients = recipients
        self.messageIds = messageIds
    }
}

/// Pure-Foundation parser for a Discord "Request my Data" package.
/// No AppKit/WebKit dependency, so it is unit-testable.
public enum PackageParser {

    public enum ParseError: LocalizedError {
        case unzipFailed
        case messagesIndexNotFound
        public var errorDescription: String? {
            switch self {
            case .unzipFailed: return "Could not unzip the package."
            case .messagesIndexNotFound:
                return "Could not find your messages folder in the package. Make sure you picked the .zip Discord sent (or its extracted folder)."
            }
        }
    }

    /// Entry point: accept a .zip or an already-extracted folder and return DM/group
    /// conversations as plain dictionaries (ready for JSONSerialization → the web view).
    public static func parseToDictionaries(_ url: URL) throws -> [[String: Any]] {
        let root = try prepareRoot(url)
        return try parse(root: root).map {
            ["channelId": $0.channelId, "type": $0.type, "label": $0.label,
             "recipients": $0.recipients, "messageIds": $0.messageIds, "count": $0.messageIds.count]
        }
    }

    /// Unzip if needed; return the folder containing the package.
    public static func prepareRoot(_ url: URL) throws -> URL {
        var isDir: ObjCBool = false
        FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir)
        if isDir.boolValue { return url }
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("undiscord-pkg-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", url.path, tmp.path]
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw ParseError.unzipFailed }
        return tmp
    }

    /// Locate the messages directory. Discord localizes its name (messages, Mensajes,
    /// Nachrichten, メッセージ, …) and newer exports may omit index.json, so we detect by
    /// CONTENT rather than name: a folder that holds either index.json or channel
    /// subfolders (each with a channel.json). Checks root, package/, and one level down.
    public static func findMessagesDir(_ root: URL) -> URL? {
        let fm = FileManager.default
        var bases = [root, root.appendingPathComponent("package")]
        if let items = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) {
            bases.append(contentsOf: items)
        }
        for base in bases {
            // A child of base might be the messages dir (e.g. root/package/Mensajes).
            if let children = try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: [.isDirectoryKey]) {
                for child in children where looksLikeMessagesDir(child) { return child }
            }
            // …or base itself is (e.g. the user picked the messages folder directly).
            if looksLikeMessagesDir(base) { return base }
        }
        return nil
    }

    /// A messages folder either carries index.json or contains at least one channel
    /// subfolder (a directory with a channel.json inside).
    public static func looksLikeMessagesDir(_ dir: URL) -> Bool {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { return false }
        if fm.fileExists(atPath: dir.appendingPathComponent("index.json").path) { return true }
        guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { return false }
        return items.contains { fm.fileExists(atPath: $0.appendingPathComponent("channel.json").path) }
    }

    /// Parse the messages directory into DM (1) and group DM (3) conversations.
    public static func parse(root: URL) throws -> [ParsedChannel] {
        let fm = FileManager.default
        guard let msgs = findMessagesDir(root) else { throw ParseError.messagesIndexNotFound }

        let indexData = (try? Data(contentsOf: msgs.appendingPathComponent("index.json"))) ?? Data()
        let index = (try? JSONSerialization.jsonObject(with: indexData)) as? [String: Any] ?? [:]

        var out: [ParsedChannel] = []
        let dirs = (try? fm.contentsOfDirectory(at: msgs, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        for dir in dirs {
            let isDir = (try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            guard isDir else { continue }
            guard let chData = try? Data(contentsOf: dir.appendingPathComponent("channel.json")),
                  let ch = (try? JSONSerialization.jsonObject(with: chData)) as? [String: Any] else { continue }
            let type = normalizeType(ch["type"])
            guard type == 1 || type == 3 else { continue }
            let id = (ch["id"] as? String) ?? (ch["id"].map { "\($0)" } ?? "")
            guard !id.isEmpty else { continue }
            let recipients = (ch["recipients"] as? [String]) ?? []
            let label = (index[id] as? String) ?? (ch["name"] as? String) ?? "DM \(id)"
            let ids = readMessageIds(dir)
            guard !ids.isEmpty else { continue }
            out.append(ParsedChannel(channelId: id, type: type, label: label,
                                     recipients: recipients, messageIds: ids))
        }
        return out
    }

    /// Normalize a channel `type` to its API integer. Newer packages use strings
    /// ("DM", "GROUP_DM", "GUILD_TEXT", …); older ones used the raw API integer.
    public static func normalizeType(_ raw: Any?) -> Int {
        if let i = raw as? Int { return i }
        if let n = raw as? NSNumber { return n.intValue }
        if let s = raw as? String {
            switch s.uppercased() {
            case "DM": return 1
            case "GROUP_DM": return 3
            case "GUILD_TEXT": return 0
            case "GUILD_VOICE": return 2
            case "GUILD_ANNOUNCEMENT": return 5
            default: return Int(s) ?? -1 // tolerate a numeric string
            }
        }
        return -1
    }

    /// Read message ids from messages.json (current format) or messages.csv (older).
    public static func readMessageIds(_ dir: URL) -> [String] {
        if let d = try? Data(contentsOf: dir.appendingPathComponent("messages.json")),
           let arr = (try? JSONSerialization.jsonObject(with: d)) as? [[String: Any]] {
            return arr.compactMap { row in
                if let s = row["ID"] as? String { return s }
                if let n = row["ID"] as? NSNumber { return n.stringValue }
                if let s = row["id"] as? String { return s }
                if let n = row["id"] as? NSNumber { return n.stringValue }
                return nil
            }
        }
        if let text = try? String(contentsOf: dir.appendingPathComponent("messages.csv"), encoding: .utf8) {
            return parseCsvFirstColumn(text)
        }
        return []
    }

    /// Extract the first CSV column (message id) per record, tolerating quoted fields
    /// with embedded commas/newlines. Drops the header and non-numeric rows.
    public static func parseCsvFirstColumn(_ text: String) -> [String] {
        var ids: [String] = []
        var first = ""
        var col = 0
        var inQuotes = false
        for ch in text {
            if inQuotes {
                if ch == "\"" { inQuotes = false }
                continue
            }
            switch ch {
            case "\"": inQuotes = true
            case ",": col += 1
            case "\n", "\r\n", "\r":
                let v = first.trimmingCharacters(in: .whitespaces)
                if !v.isEmpty { ids.append(v) }
                first = ""; col = 0
            default:
                if col == 0 { first.append(ch) }
            }
        }
        let v = first.trimmingCharacters(in: .whitespaces)
        if !v.isEmpty { ids.append(v) }
        return ids.filter { !$0.isEmpty && $0.allSatisfy(\.isNumber) }
    }
}
