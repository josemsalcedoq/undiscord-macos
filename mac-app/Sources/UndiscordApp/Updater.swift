import AppKit
import Foundation
import UndiscordCore

/// Lightweight self-updater for the (unsigned) app: checks the GitHub "latest release"
/// on launch, and if a newer version exists, offers to download the DMG, replace the app
/// bundle in place, and relaunch. Shows a "What's new" changelog after an update.
final class Updater {
    static let shared = Updater()
    private let repo = "josemsalcedoq/undiscord-fork"

    struct Release {
        let tag: String
        let version: Version
        let notes: String
        let dmgURL: URL?
    }

    var currentVersion: Version {
        Version(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0")
    }

    // MARK: - Public entry points

    /// Called on launch (silent) and from the menu (interactive).
    func checkForUpdates(silent: Bool) {
        fetchLatest { [weak self] release in
            guard let self else { return }
            DispatchQueue.main.async {
                guard let release else {
                    if !silent { self.info("Couldn't check for updates", "Please check your connection and try again.") }
                    return
                }
                if release.version > self.currentVersion {
                    self.promptUpdate(release)
                } else if !silent {
                    self.info("You're up to date", "Undiscord \(self.currentVersion) is the latest version.")
                }
            }
        }
    }

    /// If the app was updated since last launch, show the changelog once.
    func showWhatsNewIfUpdated() {
        let d = UserDefaults.standard
        let key = "undiscord.lastRunVersion"
        let cur = currentVersion
        let last = d.string(forKey: key).map(Version.init)
        d.set(cur.description, forKey: key)
        guard let last, cur > last else { return }
        fetchLatest { [weak self] r in
            guard let self else { return }
            DispatchQueue.main.async {
                let notes = (r != nil && r!.version == cur && !r!.notes.isEmpty)
                    ? r!.notes : "You're now running Undiscord \(cur)."
                let a = NSAlert()
                a.messageText = "What's new in Undiscord \(cur)"
                a.accessoryView = self.notesView(notes)
                a.addButton(withTitle: "Continue")
                a.runModal()
            }
        }
    }

    // MARK: - Network

    func fetchLatest(_ completion: @escaping (Release?) -> Void) {
        guard let url = URL(string: "https://api.github.com/repos/\(repo)/releases/latest") else {
            completion(nil); return
        }
        var req = URLRequest(url: url, timeoutInterval: 12)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Undiscord-Updater", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: req) { data, _, _ in
            guard let data,
                  let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                  let tag = json["tag_name"] as? String else { completion(nil); return }
            let notes = (json["body"] as? String) ?? ""
            var dmg: URL?
            if let assets = json["assets"] as? [[String: Any]] {
                for a in assets where (a["name"] as? String)?.lowercased().hasSuffix(".dmg") == true {
                    if let s = a["browser_download_url"] as? String { dmg = URL(string: s); break }
                }
            }
            completion(Release(tag: tag, version: Version(tag), notes: notes, dmgURL: dmg))
        }.resume()
    }

    // MARK: - UI

    private func promptUpdate(_ r: Release) {
        let alert = NSAlert()
        alert.messageText = "Update available — Undiscord \(r.version)"
        alert.informativeText = "You have \(currentVersion). Update to get the latest.\n\nWhat's new:"
        alert.accessoryView = notesView(r.notes)
        alert.addButton(withTitle: "Update Now")
        alert.addButton(withTitle: "Later")
        if alert.runModal() == .alertFirstButtonReturn { downloadAndInstall(r) }
    }

    private func notesView(_ text: String) -> NSView {
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 430, height: 190))
        scroll.hasVerticalScroller = true
        scroll.borderType = .lineBorder
        let tv = NSTextView(frame: scroll.bounds)
        tv.isEditable = false
        tv.isSelectable = true
        tv.string = text.isEmpty ? "No release notes." : text
        tv.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        tv.textContainerInset = NSSize(width: 8, height: 8)
        scroll.documentView = tv
        return scroll
    }

    private func showSpinner(_ text: String) -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 340, height: 92),
                         styleMask: [.titled], backing: .buffered, defer: false)
        w.title = "Undiscord"
        w.center()
        let v = NSView(frame: NSRect(x: 0, y: 0, width: 340, height: 92))
        let spinner = NSProgressIndicator(frame: NSRect(x: 22, y: 35, width: 22, height: 22))
        spinner.style = .spinning
        spinner.startAnimation(nil)
        let label = NSTextField(labelWithString: text)
        label.frame = NSRect(x: 54, y: 35, width: 268, height: 20)
        v.addSubview(spinner); v.addSubview(label)
        w.contentView = v
        w.makeKeyAndOrderFront(nil)
        return w
    }

    private func info(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.addButton(withTitle: "OK")
        a.runModal()
    }

    private func openReleasesPage(_ msg: String) {
        info("Update", msg)
        if let u = URL(string: "https://github.com/\(repo)/releases/latest") { NSWorkspace.shared.open(u) }
    }

    // MARK: - Download & install

    private func downloadAndInstall(_ r: Release) {
        let appPath = Bundle.main.bundlePath
        guard appPath.hasSuffix(".app") else {
            openReleasesPage("This is a development build, not an installed app. Please update manually.")
            return
        }
        guard let dmgURL = r.dmgURL else {
            openReleasesPage("No installer was found in the release. Please update manually.")
            return
        }
        let spinner = showSpinner("Downloading Undiscord \(r.version)…")
        URLSession.shared.downloadTask(with: dmgURL) { [weak self] tmp, _, err in
            guard let self else { return }
            DispatchQueue.main.async {
                spinner.close()
                guard let tmp, err == nil else {
                    self.openReleasesPage("Download failed. Please update manually."); return
                }
                let dest = FileManager.default.temporaryDirectory.appendingPathComponent("Undiscord-update.dmg")
                try? FileManager.default.removeItem(at: dest)
                do { try FileManager.default.moveItem(at: tmp, to: dest) }
                catch { self.openReleasesPage("Couldn't save the download. Please update manually."); return }
                self.runInstaller(dmgPath: dest.path, appPath: appPath)
            }
        }.resume()
    }

    private func runInstaller(dmgPath: String, appPath: String) {
        // Waits for this process to quit, then swaps the bundle from the DMG and relaunches.
        let script = """
        #!/bin/bash
        DMG="$1"; APP="$2"; PID="$3"
        for _ in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
        MNT="$(mktemp -d)"
        hdiutil attach "$DMG" -nobrowse -noverify -mountpoint "$MNT" >/dev/null 2>&1 || exit 1
        if [ -d "$MNT/Undiscord.app" ]; then
          rm -rf "$APP"
          cp -R "$MNT/Undiscord.app" "$APP"
          xattr -dr com.apple.quarantine "$APP" 2>/dev/null
        fi
        hdiutil detach "$MNT" >/dev/null 2>&1
        rm -f "$DMG"
        open "$APP"
        """
        let scriptPath = FileManager.default.temporaryDirectory.appendingPathComponent("undiscord-update.sh").path
        do { try script.write(toFile: scriptPath, atomically: true, encoding: .utf8) }
        catch { openReleasesPage("Couldn't prepare the installer. Please update manually."); return }

        let pid = ProcessInfo.processInfo.processIdentifier
        let cmd = "nohup /bin/bash \"\(scriptPath)\" \"\(dmgPath)\" \"\(appPath)\" \(pid) >/tmp/undiscord-update.log 2>&1 &"
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", cmd]
        do { try p.run() }
        catch { openReleasesPage("Couldn't start the installer. Please update manually."); return }

        // Quit so the installer can replace this bundle; it relaunches the new version.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { NSApp.terminate(nil) }
    }
}
