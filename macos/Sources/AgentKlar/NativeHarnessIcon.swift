import AppKit
import SwiftUI

struct NativeHarnessIcon: View {
    let harness: String
    var size: CGFloat = 20

    private var image: NSImage? {
        let bundles = ["codex": "com.openai.codex", "claude": "com.anthropic.claudefordesktop", "muse": "com.meta.endo", "gemini": "com.google.GeminiMacOS", "antigravity": "com.google.antigravity-ide", "zcode": "dev.zcode.app"]
        if let id = bundles[harness], let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
            return NSWorkspace.shared.icon(forFile: app.path)
        }
        let assets = ["claude": "anthropic", "opencode": "opencode", "gemini": "gemini", "cursor-agent": "cursor"]
        guard let asset = assets[harness], let url = Bundle.main.url(forResource: asset, withExtension: "svg", subdirectory: "harness-icons") else { return nil }
        let mark = NSImage(contentsOf: url)
        mark?.isTemplate = true
        return mark
    }

    var body: some View {
        Group {
            if let image { Image(nsImage: image).resizable().scaledToFit() }
            else { Text(harness == "auto" ? "⋯" : String(harness.prefix(1)).uppercased()).font(.system(size: size * 0.65, weight: .semibold)).frame(width: size, height: size).background(.quaternary, in: RoundedRectangle(cornerRadius: 4)) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
