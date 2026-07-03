import Foundation

/// A lenient semantic version. Accepts "v0.2.0", "0.2.0", "1.2", "0.2.0-beta.1", etc.
/// Pre-release/build suffixes on a component are ignored (only leading digits count).
public struct Version: Comparable, CustomStringConvertible, Equatable {
    public let major: Int
    public let minor: Int
    public let patch: Int

    public init(_ major: Int, _ minor: Int, _ patch: Int) {
        self.major = major; self.minor = minor; self.patch = patch
    }

    public init(_ string: String) {
        var s = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if s.hasPrefix("v") { s.removeFirst() }
        let comps = s.split(separator: ".")
        func part(_ i: Int) -> Int {
            guard i < comps.count else { return 0 }
            return Int(comps[i].prefix(while: { $0.isNumber })) ?? 0
        }
        major = part(0); minor = part(1); patch = part(2)
    }

    public var description: String { "\(major).\(minor).\(patch)" }

    public static func < (a: Version, b: Version) -> Bool {
        if a.major != b.major { return a.major < b.major }
        if a.minor != b.minor { return a.minor < b.minor }
        return a.patch < b.patch
    }
}
