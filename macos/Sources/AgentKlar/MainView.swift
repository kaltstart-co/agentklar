import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct MainView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var section: String? = "Work"
    @State private var choosingProject = false
    @State private var choosingPicture = false
    @State private var pictureProjectID = ""
    @StateObject private var pictures = ProjectPictureStore()
    private let sections = [("Work", "checklist"), ("Instructions", "doc.text"), ("Context", "text.alignleft"),
                            ("Team", "person.2"), ("Models", "cpu"), ("Usage", "chart.bar"), ("Settings", "gear")]
    var body: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                projectSwitcher.padding(.horizontal, 12).padding(.vertical, 10)
                List(selection: $section) {
                    ForEach(sections, id: \.0) { item in
                        HStack(spacing: 10) { Image(systemName: item.1).frame(width: 20); Text(item.0).lineLimit(1) }.tag(item.0)
                    }
                }.listStyle(.sidebar)
            }.navigationTitle("AgentKlar").navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 280)
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
                        if !["Work", "Models", "Usage"].contains(section ?? "Work") { Button("Refresh", systemImage: "arrow.clockwise") { Task { await client.refresh() } }.disabled(!client.connected || client.busy) }
                    }
                }
        }.disabled(client.busy).frame(minWidth: 640, minHeight: 520)
        .fileImporter(isPresented: $choosingProject, allowedContentTypes: [.folder], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let folders):
                if let folder = folders.first { Task { await client.registerProject(name: folder.lastPathComponent, path: folder.path) } }
            case .failure: client.error = "The project folder could not be selected. Try Add project again."
            }
        }
        .fileImporter(isPresented: $choosingPicture, allowedContentTypes: [.image], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let files):
                if let file = files.first { do { try pictures.save(file, projectID: pictureProjectID) } catch { client.error = error.localizedDescription } }
            case .failure: client.error = "The project picture could not be selected. Try choosing an image again."
            }
        }
        .task(id: client.projects.compactMap { $0["id"].string }.joined(separator: ":")) { pictures.load(client.projects.compactMap { $0["id"].string }) }
        .onChange(of: client.requestedRunID) { _, id in if id != nil { section = "Work" } }
        .task {
            if !client.connected { await client.connect() }
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await client.refresh()
            }
        }
    }
    private var projectSwitcher: some View {
        HStack(spacing: 9) {
            NativeProjectAvatar(projectID: client.projectID, name: client.project["name"].string ?? "Project", store: pictures)
            Menu {
            ForEach(client.projects, id: \.selfID) { project in
                Button { if let id = project["id"].string { Task { await client.selectProject(id) } } } label: {
                    if project["id"].string == client.projectID { Label(project["name"].string ?? "Project", systemImage: "checkmark") }
                    else { Text(project["name"].string ?? "Project") }
                }
            }
            Divider()
            Button("Add project folder…", systemImage: "folder.badge.plus", action: addProject)
            Button("Choose project picture…", systemImage: "photo") { pictureProjectID = client.projectID; choosingPicture = true }.disabled(client.projectID.isEmpty)
            Button("Remove project picture", systemImage: "trash", role: .destructive) {
                do { try pictures.remove(client.projectID) } catch { client.error = error.localizedDescription }
            }.disabled(pictures.pictures[client.projectID] == nil)
            Text("Project pictures stay on this Mac.")
            } label: {
                Text(client.project["name"].string ?? "Choose a project").lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
            }.menuStyle(.borderlessButton).menuIndicator(.visible)
                .frame(minWidth: 0, maxWidth: .infinity)
                .accessibilityLabel("Project: " + (client.project["name"].string ?? "Choose a project"))
        }.frame(maxWidth: .infinity).disabled(!client.connected)
            .help("Switch projects or choose a project picture. Pictures stay on this Mac.")
    }
    private func confirmUpdate() {
        let alert = NSAlert(); alert.messageText = "Update the local service?"
        alert.informativeText = "AgentKlar checks that background work is idle before updating and reconnecting."
        alert.addButton(withTitle: "Update"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { Task { await client.updateService() } }
    }
    private func addProject() {
        choosingProject = true
    }
}
