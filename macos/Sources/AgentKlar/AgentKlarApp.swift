import SwiftUI
import AppKit

@main struct AgentKlarApp: App {
    @StateObject private var client: AgentKlarClient
    @StateObject private var updates: NativeUpdates
    init() {
        let client = AgentKlarClient()
        _client = StateObject(wrappedValue: client)
        _updates = StateObject(wrappedValue: NativeUpdates(client: client))
    }
    var body: some Scene {
        WindowGroup { MainView(client: client).environmentObject(updates) }
            .defaultSize(width: 1280, height: 820)
            .windowToolbarStyle(.unifiedCompact)
            .commands {
                CommandGroup(after: .appInfo) { Button("Check for App Updates…") { updates.checkForUpdates() }.disabled(!updates.canCheck || !client.maintenanceReady) }
                CommandGroup(after: .newItem) {
                    Button("Reconnect AgentKlar") { Task { await client.connect() } }.disabled(!client.maintenanceReady)
                    Button("Update Background Components…") { confirmServiceUpdate() }.disabled(!client.maintenanceReady)
                }
            }
    }
    private func confirmServiceUpdate() {
        let alert = NSAlert(); alert.messageText = "Update AgentKlar’s background components?"
        alert.informativeText = "AgentKlar checks that background work is idle before updating."
        alert.addButton(withTitle: "Update"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { Task { await client.updateService() } }
    }

}
