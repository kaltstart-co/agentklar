import SwiftUI
import AppKit

struct MainView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var section: String? = "Work"
    private let sections = [("Work", "checklist"), ("Instructions", "doc.text"), ("Context", "text.alignleft"),
                            ("Team", "person.2"), ("Models", "cpu"), ("Usage", "chart.bar"), ("Settings", "gear")]
    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                Picker("Project", selection: Binding(get: { client.projectID }, set: { id in Task { await client.selectProject(id) } })) {
                    if client.projects.isEmpty { Text("No project").tag("") }
                    ForEach(client.projects, id: \.self) { project in Text(project["name"].string ?? "Project").tag(project["id"].string ?? "") }
                }.pickerStyle(.menu).disabled(!client.connected).padding()
                List(selection: $section) { ForEach(sections, id: \.0) { item in Label(item.0, systemImage: item.1).tag(item.0) } }
            }.navigationTitle("AgentKlar").navigationSplitViewColumnWidth(min: 190, ideal: 220)
        } detail: {
            VStack(spacing: 0) {
                if !client.error.isEmpty {
                    HStack { Image(systemName: "exclamationmark.triangle"); Text(client.error); Spacer(); Button("Dismiss") { client.error = "" } }
                        .foregroundStyle(.secondary).padding().background(.quaternary)
                }
                if !client.connected {
                    ContentUnavailableView {
                        Label("Connect your local service", systemImage: "desktopcomputer")
                    } description: {
                        Text("AgentKlar uses your existing signed-in coding apps. Your background work continues when this app closes.")
                    } actions: {
                        Button("Connect") { Task { await client.connect() } }.disabled(client.busy || client.runtime.mutationRunning)
                        if !client.runtime.hasExistingLauncher {
                            Button("Set up locally") { Task { await client.installService() } }.disabled(client.busy || client.runtime.mutationRunning)
                        }
                        if client.error.contains("needs an update") {
                            Button("Update local service") { confirmUpdate() }.disabled(client.busy || client.runtime.mutationRunning)
                        }
                    }
                } else {
                    switch section ?? "Work" {
                    case "Instructions", "Context": ProjectDetailsView(client: client, section: section ?? "Context")
                    case "Team": TeamView(client: client)
                    case "Models", "Usage": ModelUsageView(client: client, section: section ?? "Models")
                    case "Settings": NativeSettingsView(client: client)
                    default: WorkView(client: client)
                    }
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top).navigationTitle(section ?? "Work")
                .toolbar {
                    ToolbarItemGroup {
                        if client.busy { ProgressView().controlSize(.small) }
                        Button("Add project", systemImage: "folder.badge.plus", action: addProject).disabled(!client.connected || client.busy)
                        Button("Refresh", systemImage: "arrow.clockwise") { Task { await client.refresh() } }.disabled(!client.connected || client.busy)
                    }
                }
        }.disabled(client.busy).frame(minWidth: 900, minHeight: 600).task {
            if !client.connected { await client.connect() }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await client.refresh()
            }
        }
    }
    private func confirmUpdate() {
        let alert = NSAlert(); alert.messageText = "Update the local service?"
        alert.informativeText = "AgentKlar checks that background work is idle before updating and reconnecting."
        alert.addButton(withTitle: "Update"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { Task { await client.updateService() } }
    }
    private func addProject() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK, let url = panel.url { Task { await client.registerProject(name: url.lastPathComponent, path: url.path) } }
    }
}
