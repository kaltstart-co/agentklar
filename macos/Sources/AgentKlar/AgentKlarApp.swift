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
            .commands {
                CommandGroup(after: .appInfo) { Button("Check for App Updates…") { updates.checkForUpdates() }.disabled(!updates.canCheck) }
                CommandGroup(after: .newItem) {
                    Button("Reconnect Local Service") { Task { await client.connect() } }.disabled(client.busy || client.runtime.mutationRunning)
                    Button("Update Local Service…") { confirmServiceUpdate() }.disabled(client.busy || client.runtime.mutationRunning)
                }
            }
    }
    private func confirmServiceUpdate() {
        let alert = NSAlert(); alert.messageText = "Update the local service?"
        alert.informativeText = "AgentKlar checks that the managed service is idle before updating. Your coding apps and accounts stay in place."
        alert.addButton(withTitle: "Update"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { Task { await client.updateService() } }
    }

}
