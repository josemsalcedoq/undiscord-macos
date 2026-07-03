import AppKit
import WebKit
import UniformTypeIdentifiers
import UndiscordCore

// A tiny native macOS shell: it embeds a WKWebView, loads Discord's web client,
// and injects the Undiscord panel. No Tampermonkey needed — the app IS the script
// host. Your login persists between launches (default data store), and injecting via
// WKUserScript sidesteps Discord's CSP (which blocks bookmarklets). A native bridge
// lets the panel import a Discord Data Package (.zip) to reach your full DM history.

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persist cookies/localStorage → stay logged in

        // Inject the userscript at document end, main frame only.
        if let url = Bundle.module.url(forResource: "undiscord", withExtension: "js"),
           let js = try? String(contentsOf: url, encoding: .utf8) {
            let script = WKUserScript(source: js, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            config.userContentController.addUserScript(script)
        } else {
            NSLog("undiscord.js resource not found — panel will not load.")
        }

        // Bridge: the panel posts { action: "import" } to open a data package.
        config.userContentController.add(self, name: "undms")

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self // needed so JS alert()/confirm()/prompt() actually show
        webView.allowsBackForwardNavigationGestures = true

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1220, height: 840),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Undiscord"
        window.center()
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)

        webView.load(URLRequest(url: URL(string: "https://discord.com/app")!))

        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        // Show the changelog if we just updated, then quietly check for a newer release.
        Updater.shared.showWhatsNewIfUpdated()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            Updater.shared.checkForUpdates(silent: true)
        }
    }

    @objc func checkForUpdatesMenu() {
        Updater.shared.checkForUpdates(silent: false)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - WKUIDelegate (JS dialogs)
    // Without these, WKWebView silently ignores alert/confirm/prompt and confirm()
    // returns false — which is why "Delete selected" appeared to do nothing.

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = "Undiscord"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.runModal()
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Undiscord"
        alert.informativeText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Undiscord"
        alert.informativeText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        completionHandler(alert.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // MARK: - Data Package import bridge

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "undms", let body = message.body as? [String: Any] else { return }
        switch body["action"] as? String {
        case "import": importDataPackage()
        case "saveLog": saveDebugLog(body["content"] as? String ?? "")
        case "setInspectable": setInspectable((body["value"] as? Bool) ?? false)
        default: break
        }
    }

    // MARK: - Debug mode bridge

    private func setInspectable(_ on: Bool) {
        if #available(macOS 13.3, *) { webView.isInspectable = on }
    }

    private func saveDebugLog(_ content: String) {
        let panel = NSSavePanel()
        let stamp = DateFormatter()
        stamp.dateFormat = "yyyyMMdd-HHmmss"
        panel.nameFieldStringValue = "undiscord-debug-\(stamp.string(from: Date())).log"
        if let log = UTType(filenameExtension: "log") { panel.allowedContentTypes = [log, .plainText] }
        panel.begin { resp in
            guard resp == .OK, let url = panel.url else { return }
            try? content.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    @objc func importDataPackage() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Select your Discord data package (.zip) or its extracted folder"
        if let zip = UTType(filenameExtension: "zip") { panel.allowedContentTypes = [zip, .folder] }
        panel.begin { [weak self] resp in
            guard let self, resp == .OK, let url = panel.url else { return }
            self.notifyJS("Reading data package… this can take a moment.")
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let channels = try PackageParser.parseToDictionaries(url)
                    let data = try JSONSerialization.data(withJSONObject: channels, options: [])
                    let json = String(data: data, encoding: .utf8) ?? "[]"
                    DispatchQueue.main.async {
                        self.webView.evaluateJavaScript("window.__undmsImport(\(json))", completionHandler: nil)
                    }
                } catch {
                    DispatchQueue.main.async { self.notifyJS("Import failed: \(error.localizedDescription)") }
                }
            }
        }
    }

    private func notifyJS(_ msg: String) {
        let escaped = msg.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        webView.evaluateJavaScript("window.__undmsStatus && window.__undmsStatus(\"\(escaped)\")", completionHandler: nil)
    }

    // Minimal menu so Cmd+Q and clipboard shortcuts (needed to type/paste your
    // Discord login) work inside the web view.
    private func setupMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Check for Updates…", action: #selector(checkForUpdatesMenu), keyEquivalent: "")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Hide Undiscord", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Undiscord", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem()
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Import Data Package…", action: #selector(importDataPackage), keyEquivalent: "i")
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
