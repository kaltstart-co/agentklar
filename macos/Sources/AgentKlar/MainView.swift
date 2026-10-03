import SwiftUI
import AppKit
import UniformTypeIdentifiers

struct MainView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var activeProject = ""
    @State private var workspaces: [String: AgentKlarClient] = [:]
    @State private var pages: [String: String] = [:]
    @State private var openProjectIDs: [String] = []
    @State private var initializedTabs = false
    @AppStorage("AgentKlar.openProjectTabs") private var savedProjectTabs = ""
    @State private var remoteProjects: [String: (connection: JSON, project: JSON)] = [:]
    @State private var showingRemoteSetup = false
    @State private var choosingProject = false
    @State private var showingProjects = false
    @State private var projectSearch = ""
    @State private var choosingPicture = false
    @State private var showingPicture = false
    @State private var pictureProjectID = ""
    @StateObject private var pictures = ProjectPictureStore()
    private let sections = [("Work", "checklist"), ("Instructions", "doc.text"), ("Context", "text.alignleft"),
                            ("Team", "person.2"), ("Models", "cpu"), ("Usage", "chart.bar"), ("Settings", "gearshape")]
    private var page: String { pages[activeProject] ?? "Work" }
    private var projectIDs: [String] { client.projects.compactMap { $0["id"].string } }

    var body: some View {
        NavigationSplitView {
            VStack(alignment: .leading, spacing: 0) {
                Label("AgentKlar", systemImage: "square.stack.3d.up").font(.system(size: 14, weight: .semibold))
                    .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 20)
                if remoteProjects[activeProject] != nil {
                    VStack(spacing: 4) {
                        sidebarLink(("Work", "checklist"))
                        sidebarLink(("Context", "text.alignleft"))
                        sidebarLink(("Connections", "link"))
                    }.padding(.horizontal, 10)
                    Button { showingRemoteSetup = true } label: {
                        Label("Manage Macs", systemImage: "desktopcomputer")
                            .frame(maxWidth: .infinity, alignment: .leading).padding(10).contentShape(Rectangle())
                    }.buttonStyle(.plain).padding(.horizontal, 10)
                    Spacer()
                } else {
                    VStack(spacing: 4) {
                        ForEach(sections.dropLast(), id: \.0) { item in sidebarLink(item) }
                    }.padding(.horizontal, 10)
                    Spacer()
                    sidebarLink(("Settings", "gearshape")).padding(.horizontal, 10)
                }
                Label(client.connected ? "Connected" : client.busy ? "Connecting…" : "Connection needed",
                      systemImage: client.connected ? "checkmark.circle" : "circle.dotted")
                    .font(NativeStyle.caption).foregroundStyle(.secondary).padding(18)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 240)
        } detail: {
            VStack(spacing: 0) {
                if client.hasLoadedWorkspace { projectTabs }
                if !client.error.isEmpty { connectionNotice }
                if client.hasLoadedWorkspace {
                    GeometryReader { space in ZStack {
                        ForEach(workspaces.keys.sorted(), id: \.self) { id in
                            if let workspace = workspaces[id] {
                                NativeWorkspaceScene(client: workspace, page: Binding(get: { pages[id] ?? "Work" }, set: { pages[id] = $0 }), active: activeProject == id)
                                    .frame(width: space.size.width, height: space.size.height, alignment: .topLeading)
                                    .opacity(activeProject == id ? 1 : 0)
                                    .disabled(activeProject != id)
                                    .allowsHitTesting(activeProject == id)
                                    .accessibilityElement(children: .contain)
                                    .accessibilityHidden(activeProject != id)
                            }
                        }
                        ForEach(remoteProjects.keys.sorted(), id: \.self) { id in
                            if let remote = remoteProjects[id] {
                                NativeRemoteProjectView(client: client, connection: remote.connection, project: remote.project,
                                    page: Binding(get: { pages[id] ?? "Work" }, set: { pages[id] = $0 }))
                                    .frame(width: space.size.width, height: space.size.height, alignment: .topLeading)
                                    .opacity(activeProject == id ? 1 : 0).disabled(activeProject != id)
                                    .allowsHitTesting(activeProject == id).accessibilityHidden(activeProject != id)
                            }
                        }
                        if activeProject.isEmpty {
                            NativeEmptyState("Open a project", systemImage: "folder", description: "Choose a project to view its work, team and shared context.") {
                                Button("Open project", systemImage: "plus") { showingProjects = true }.disabled(!client.connected)
                            }
                        }
                    }.frame(width: space.size.width, height: space.size.height, alignment: .topLeading).clipped() }
                } else { welcome }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                .background(Color(nsColor: .textBackgroundColor))
                .navigationTitle("AgentKlar")
                .toolbar {
                    ToolbarItemGroup {
                        if client.busy { ProgressView().controlSize(.small) }
                    }
                }
        }.frame(minWidth: 850, maxWidth: .infinity, minHeight: 600, maxHeight: .infinity, alignment: .topLeading)
        .fileImporter(isPresented: $choosingProject, allowedContentTypes: [.folder], allowsMultipleSelection: false) { result in
            switch result {
            case .success(let folders):
                if let folder = folders.first { Task { await client.registerProject(name: folder.lastPathComponent, path: folder.path); activate(client.projectID, persist: false) } }
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
        .sheet(isPresented: $showingPicture) { pictureEditor }
        .sheet(isPresented: $showingProjects) { projectChooser }
        .sheet(isPresented: $showingRemoteSetup) {
            NativeDetailPage(title: "Connected Macs") {
                NativeRemoteSetupView(client: client) { connection, project in
                    openRemote(connection, project); showingRemoteSetup = false
                }
            }
        }
        .onChange(of: client.hasLoadedWorkspace) { _, loaded in if loaded { initializeTabs() } }
        .onChange(of: projectIDs) { _, ids in
            pictures.load(ids)
            workspaces = workspaces.filter { ids.contains($0.key) }
            openProjectIDs = openProjectIDs.filter { ids.contains($0) || remoteProjects[$0] != nil }
            if initializedTabs { savedProjectTabs = openProjectIDs.filter { remoteProjects[$0] == nil }.joined(separator: ",") }
            if initializedTabs && !ids.contains(activeProject) && remoteProjects[activeProject] == nil {
                if let next = openProjectIDs.last { activate(next, persist: false) } else { activeProject = "" }
            }
        }
        .task {
            if !client.connected { await client.connect() }
            initializeTabs()
            pictures.load(projectIDs)
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await client.refresh()
            }
        }
    }
    private func sidebarLink(_ item: (String, String)) -> some View {
        Button { pages[activeProject] = item.0 } label: {
            HStack(spacing: 11) {
                Image(systemName: item.1).font(.system(size: 15, weight: .regular)).frame(width: 20)
                    .foregroundStyle(page == item.0 ? Color.accentColor : Color.secondary)
                Text(item.0).font(.system(size: 14, weight: page == item.0 ? .medium : .regular))
                    .foregroundStyle(page == item.0 ? .primary : .secondary)
                Spacer(minLength: 0)
            }.padding(.horizontal, 10).frame(maxWidth: .infinity).frame(height: 36)
                .background(page == item.0 ? Color.accentColor.opacity(0.09) : .clear, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(activeProject.isEmpty)
            .accessibilityAddTraits(page == item.0 ? .isSelected : [])
    }
    private func initializeTabs() {
        guard client.hasLoadedWorkspace, !initializedTabs else { return }
        initializedTabs = true
        openProjectIDs = savedProjectTabs.split(separator: ",").map(String.init).filter { projectIDs.contains($0) }
        for id in openProjectIDs { workspaces[id] = client.workspace(for: id) }
        activate(client.projectID, persist: false)
    }
    private var projectTabs: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 4) {
                ForEach(openProjectIDs, id: \.self) { id in
                    projectTabRow(id)
                }
            Button { showingProjects = true } label: {
                Image(systemName: "plus").font(.system(size: 16)).frame(width: 28, height: 28)
            }.buttonStyle(.plain).help("Open project (⌘O)").accessibilityLabel("Open project").keyboardShortcut("o")
                .disabled(!client.connected || client.busy)
            }.padding(.vertical, 6)
        }.scrollIndicators(.hidden).padding(.horizontal, 20).frame(height: 48).overlay(alignment: .bottom) { Divider() }
    }
    private func projectTabName(_ id: String) -> String {
        let project = remoteProjects[id]?.project ?? client.projects.first { $0["id"].string == id } ?? .null
        return project["name"].string ?? "Project"
    }
    private func projectTabTitle(_ id: String, name: String) -> String {
        guard let remote = remoteProjects[id] else { return name }
        return name + " · " + (remote.connection["label"].string ?? "Remote Mac")
    }
    private func projectTabLabel(_ id: String, name: String) -> some View {
        HStack(spacing: 9) {
            NativeProjectAvatar(projectID: id, name: name, store: pictures, size: 20)
            Text(projectTabTitle(id, name: name)).lineLimit(1)
                .truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                .font(.system(size: 13, weight: activeProject == id ? .medium : .regular))
        }
    }
    private func projectTabRow(_ id: String) -> some View {
        let name = projectTabName(id)
        return HStack(spacing: 8) {
            Button { activate(id) } label: { projectTabLabel(id, name: name) }
                .buttonStyle(.plain).help(name)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("Project tab: " + name)
                .accessibilityAddTraits(activeProject == id ? .isSelected : [])
            Button { closeProject(id) } label: {
                Image(systemName: "xmark").font(.system(size: 10)).foregroundStyle(.secondary)
            }.buttonStyle(.plain).accessibilityLabel("Close project: " + name)
        }.padding(.horizontal, 12).frame(width: 196, height: 34)
            .background(activeProject == id ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(activeProject == id ? Color.primary.opacity(0.08) : .clear))
            .contextMenu {
                Button("Change project picture…") { pictureProjectID = id; showingPicture = true }
                Button("Close project") { closeProject(id) }
            }
    }
    private var matchingProjects: [JSON] {
        let query = projectSearch.trimmingCharacters(in: .whitespacesAndNewlines)
        return client.projects.filter {
            query.isEmpty || ($0["name"].string ?? "").localizedCaseInsensitiveContains(query)
                || ($0["path"].string ?? "").localizedCaseInsensitiveContains(query)
        }
    }
    private var projectChooser: some View {
        VStack(alignment: .leading, spacing: 16) {
            NativePageHeader(title: "Open project") {
                Button("Done") { showingProjects = false }.keyboardShortcut(.cancelAction)
            }
            NativeSearchField(placeholder: "Find a project", text: $projectSearch)
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(matchingProjects, id: \.selfID) { project in
                        let id = project["id"].string ?? ""
                        Button { activate(id); showingProjects = false } label: {
                            HStack(spacing: 12) {
                                NativeProjectAvatar(projectID: id, name: project["name"].string ?? "Project", store: pictures, size: 28)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(project["name"].string ?? "Project").fontWeight(.medium).lineLimit(1)
                                    Text(project["path"].string ?? "").font(NativeStyle.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                                }.frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(10).contentShape(Rectangle())
                        }.buttonStyle(.plain).help(project["path"].string ?? "")
                    }
                    if matchingProjects.isEmpty {
                        Text("No matching projects").foregroundStyle(.secondary).padding(10)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            HStack {
                Button("Add project folder…", systemImage: "folder.badge.plus") {
                    showingProjects = false; choosingProject = true
                }.buttonStyle(.bordered)
                Button("Projects on another Mac…", systemImage: "desktopcomputer") {
                    showingProjects = false; showingRemoteSetup = true
                }.buttonStyle(.bordered)
            }
        }
        .font(NativeStyle.body).controlSize(.regular).padding(NativeStyle.pagePadding)
        .frame(minWidth: 480, idealWidth: 600, minHeight: 400, idealHeight: 500)
    }
    private var connectionNotice: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
            Text(client.error).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
            Button("Reconnect") { Task { await client.connect() } }.disabled(!client.maintenanceReady)
            Button("Dismiss") { client.error = "" }
        }.font(NativeStyle.body).padding(16).background(.quaternary)
    }
    private var welcome: some View {
        VStack(spacing: 20) {
            Image(systemName: "square.stack.3d.up").font(.system(size: 46)).foregroundStyle(.tint)
            Text(client.busy ? "Getting AgentKlar ready…" : "Welcome to AgentKlar").font(.largeTitle.weight(.semibold))
            Text("Connect your coding apps and manage work across projects. AgentKlar keeps your work running when you close this window.")
                .font(.system(size: 16)).foregroundStyle(.secondary).multilineTextAlignment(.center).frame(maxWidth: 520)
            if client.busy { ProgressView() }
            else {
                Button("Get started") { Task { await client.connect() } }.buttonStyle(.borderedProminent).controlSize(.large)
                if !client.runtime.hasExistingLauncher { Button("Set up AgentKlar") { Task { await client.installService() } } }
                if client.error.contains("needs an update") { Button("Update AgentKlar") { confirmUpdate() } }
            }
        }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    private var pictureEditor: some View {
        NativeDetailPage(title: "Project picture") {
            VStack(alignment: .leading, spacing: 20) {
                NativeProjectAvatar(projectID: pictureProjectID, name: client.projects.first { $0["id"].string == pictureProjectID }?["name"].string ?? "Project", store: pictures, size: 80)
                Text("This picture stays on this Mac.").foregroundStyle(.secondary)
                Button("Choose picture…", systemImage: "photo") { showingPicture = false; choosingPicture = true }
                Button("Remove picture", role: .destructive) {
                    do { try pictures.remove(pictureProjectID); showingPicture = false } catch { client.error = error.localizedDescription }
                }.disabled(pictures.pictures[pictureProjectID] == nil)
            }
        }
    }
    private func openRemote(_ connection: JSON, _ project: JSON) {
        guard let connectionID = connection["id"].string, let projectID = project["id"].string else { return }
        let id = "remote:" + connectionID + ":" + projectID
        remoteProjects[id] = (connection, project)
        if !openProjectIDs.contains(id) { openProjectIDs.append(id) }
        activeProject = id
    }
    private func activate(_ id: String, persist: Bool = true) {
        if remoteProjects[id] != nil { activeProject = id; return }
        guard !id.isEmpty, projectIDs.contains(id) else { activeProject = ""; return }
        if workspaces[id] == nil { workspaces[id] = client.workspace(for: id) }
        if !openProjectIDs.contains(id) { openProjectIDs.append(id); savedProjectTabs = openProjectIDs.filter { remoteProjects[$0] == nil }.joined(separator: ",") }
        activeProject = id
        if persist && client.connected && client.projectID != id { Task { await client.selectProject(id) } }
    }
    private func closeProject(_ id: String) {
        openProjectIDs.removeAll { $0 == id }
        savedProjectTabs = openProjectIDs.filter { remoteProjects[$0] == nil }.joined(separator: ",")
        if activeProject == id {
            if let next = openProjectIDs.last { activate(next) } else { activeProject = "" }
        }
    }
    private func confirmUpdate() {
        let alert = NSAlert(); alert.messageText = "Update AgentKlar?"
        alert.informativeText = "AgentKlar checks that background work is idle before updating."
        alert.addButton(withTitle: "Update"); alert.addButton(withTitle: "Cancel")
        if alert.runModal() == .alertFirstButtonReturn { Task { await client.updateService() } }
    }
}

private struct NativeWorkspaceScene: View {
    @ObservedObject var client: AgentKlarClient
    @Binding var page: String
    let active: Bool
    @State private var visited: Set<String> = ["Work"]
    private var visiblePages: [String] { visited.union([page]).sorted() }
    var body: some View {
        GeometryReader { space in ZStack {
            ForEach(visiblePages, id: \.self) { name in
                Group {
                    switch name {
                    case "Instructions", "Context": ProjectDetailsView(client: client, section: name)
                    case "Team": TeamView(client: client)
                    case "Models", "Usage": ModelUsageView(client: client, section: name, active: active && name == page)
                    case "Settings": NativeSettingsView(client: client)
                    default: WorkView(client: client, active: active && name == page)
                    }
                }.frame(width: space.size.width, height: space.size.height, alignment: .topLeading)
                    .opacity(name == page ? 1 : 0).disabled(!active || name != page)
                    .allowsHitTesting(active && name == page).accessibilityElement(children: .contain)
                    .accessibilityHidden(!active || name != page)
            }
        }.frame(width: space.size.width, height: space.size.height, alignment: .topLeading).clipped() }
            .onAppear { visited.insert(page) }.onChange(of: page) { _, next in visited.insert(next) }
            .onChange(of: client.requestedRunID) { _, id in if id != nil { page = "Work" } }
    }
}
