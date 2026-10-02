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
                    .padding(.horizontal, 18).padding(.top, 20).padding(.bottom, 16)
                VStack(spacing: 4) {
                    ForEach(sections, id: \.0) { item in
                        Button { pages[activeProject] = item.0 } label: {
                            HStack(spacing: 10) {
                                Image(systemName: item.1).font(.system(size: 16)).frame(width: 20)
                                Text(item.0).font(.system(size: 14, weight: page == item.0 ? .medium : .regular))
                                Spacer(minLength: 0)
                            }.foregroundStyle(page == item.0 ? .primary : .secondary)
                                .padding(.horizontal, 10).frame(height: 34)
                                .background(page == item.0 ? Color.primary.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 7))
                        }.buttonStyle(.plain).disabled(activeProject.isEmpty)
                            .accessibilityAddTraits(page == item.0 ? .isSelected : [])
                    }
                }.padding(.horizontal, 10)
                Spacer()
                Label(client.connected ? "Connected" : client.busy ? "Connecting…" : "Connection needed",
                      systemImage: client.connected ? "checkmark.circle" : "circle.dotted")
                    .font(NativeStyle.caption).foregroundStyle(.secondary).padding(18)
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .navigationSplitViewColumnWidth(min: 180, ideal: 200, max: 240)
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
        .onChange(of: client.hasLoadedWorkspace) { _, loaded in if loaded { initializeTabs() } }
        .onChange(of: projectIDs) { _, ids in
            pictures.load(ids)
            workspaces = workspaces.filter { ids.contains($0.key) }
            openProjectIDs = openProjectIDs.filter { ids.contains($0) }
            if initializedTabs { savedProjectTabs = openProjectIDs.joined(separator: ",") }
            if initializedTabs && !ids.contains(activeProject) {
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
    private func initializeTabs() {
        guard client.hasLoadedWorkspace, !initializedTabs else { return }
        initializedTabs = true
        openProjectIDs = savedProjectTabs.split(separator: ",").map(String.init).filter { projectIDs.contains($0) }
        for id in openProjectIDs { workspaces[id] = client.workspace(for: id) }
        activate(client.projectID, persist: false)
    }
    private var projectTabs: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(openProjectIDs, id: \.self) { id in
                    let project = client.projects.first { $0["id"].string == id } ?? .null
                    HStack(spacing: 8) {
                      Button { activate(id) } label: {
                        HStack(spacing: 9) {
                            NativeProjectAvatar(projectID: id, name: project["name"].string ?? "Project", store: pictures, size: 20)
                            Text(project["name"].string ?? "Project").lineLimit(1)
                                .truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                                .font(.system(size: 13, weight: activeProject == id ? .medium : .regular))
                        }
                      }.buttonStyle(.plain).help(project["name"].string ?? "Project")
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("Project tab: " + (project["name"].string ?? "Project"))
                        .accessibilityAddTraits(activeProject == id ? .isSelected : [])
                      Button { closeProject(id) } label: { Image(systemName: "xmark").font(.system(size: 10)).foregroundStyle(.secondary) }
                        .buttonStyle(.plain).accessibilityLabel("Close project: " + (project["name"].string ?? "Project"))
                    }.padding(.horizontal, 10).frame(width: 210, height: 32)
                        .background(activeProject == id ? Color.primary.opacity(0.06) : .clear, in: RoundedRectangle(cornerRadius: 7))
                        .overlay(RoundedRectangle(cornerRadius: 7).stroke(activeProject == id ? Color.primary.opacity(0.08) : .clear))
                        .contextMenu {
                            Button("Change project picture…") { pictureProjectID = id; showingPicture = true }
                            Button("Close project") { closeProject(id) }
                        }
                }
            Button { showingProjects = true } label: {
                Image(systemName: "plus").font(.system(size: 16)).frame(width: 28, height: 28)
            }.buttonStyle(.plain).help("Open project (⌘O)").accessibilityLabel("Open project").keyboardShortcut("o")
                .disabled(!client.connected || client.busy)
            }.padding(.vertical, 4)
        }.scrollIndicators(.hidden).padding(.horizontal, 16).frame(height: 44).overlay(alignment: .bottom) { Divider() }
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
            TextField("Find a project", text: $projectSearch)
                .textFieldStyle(.roundedBorder).padding(4)
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
            Button("Add project folder…", systemImage: "folder.badge.plus") {
                showingProjects = false; choosingProject = true
            }.buttonStyle(.bordered)
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
    private func activate(_ id: String, persist: Bool = true) {
        guard !id.isEmpty, projectIDs.contains(id) else { activeProject = ""; return }
        if workspaces[id] == nil { workspaces[id] = client.workspace(for: id) }
        if !openProjectIDs.contains(id) { openProjectIDs.append(id); savedProjectTabs = openProjectIDs.joined(separator: ",") }
        activeProject = id
        if persist && client.connected && client.projectID != id { Task { await client.selectProject(id) } }
    }
    private func closeProject(_ id: String) {
        openProjectIDs.removeAll { $0 == id }
        savedProjectTabs = openProjectIDs.joined(separator: ",")
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
