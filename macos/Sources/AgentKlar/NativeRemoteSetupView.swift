import SwiftUI
import UniformTypeIdentifiers

// Remote setup stays on the owner Mac. It does not create a local project mirror.
struct NativeRemoteSetupView: View {
    @ObservedObject var client: AgentKlarClient
    var openProject: ((JSON, JSON) -> Void)? = nil
    @State private var openedProject: JSON = .null
    @State private var openedConnection: JSON = .null
    @State private var settings: JSON = .null
    @State private var connectionID = ""
    @State private var owner: JSON = .null
    @State private var projects: [JSON] = []
    @State private var label = ""
    @State private var host = ""
    @State private var code = ""
    @State private var sourceID = ""
    @State private var rootPath = ""
    @State private var exported = ""
    @State private var selectingFolder = false
    @State private var importing = false
    @State private var sharing = false
    @State private var creating = false
    @State private var abandoningCreation = false
    @AppStorage("AgentKlar.remoteCreation.name") private var projectName = ""
    @AppStorage("AgentKlar.remoteCreation.folder") private var folderName = ""
    @AppStorage("AgentKlar.remoteCreation.request") private var creationID = ""
    @AppStorage("AgentKlar.remoteCreation.started") private var creationStarted = false
    @AppStorage("AgentKlar.remoteCreation.connection") private var creationConnection = ""
    @State private var working = false
    @State private var failure = ""
    @State private var message = ""
    @State private var generation = 0
    // Same trim characters as JavaScript String.trim(), used by the owner schema.
    private static let javascriptWhitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
    private var connections: [JSON] { settings["connections"].array ?? [] }
    private var selected: JSON { connections.first { $0["id"].string == connectionID } ?? .null }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                NativeSectionTitle(title: "Projects on another Mac", subtitle: "Connect a Mac, then create or open a project in its shared folder.")
                HStack {
                    Button("Connect Mac", systemImage: "plus") { importing = true }.disabled(creationStarted)
                    Button("Share folder on this Mac", systemImage: "folder.badge.person.crop") { sharing = true }
                    Spacer()
                    Button("Refresh") { perform { try await load() } }
                }
                Text("This Mac ID: \(settings["device"]["id"].string ?? "Loading…")").font(NativeStyle.caption).textSelection(.enabled)
                ForEach(connections, id: \.selfID) { item in
                    Button { choose(item) } label: {
                        HStack(spacing: 12) {
                            Image(systemName: "desktopcomputer").font(.title2)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item["label"].string ?? "Mac").fontWeight(.medium)
                                Text(item["sshHost"].string ?? "").font(NativeStyle.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if connectionID == item["id"].string { Image(systemName: "checkmark") }
                        }.padding(12).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
                if selected != .null {
                    Divider()
                    HStack {
                        Text(owner == .null ? "Verify this Mac to load projects." : "Owner verified: \(owner["device"]["label"].string ?? selected["label"].string ?? "Mac")")
                        Spacer()
                        Button("Verify and load projects") { verify() }
                        Button("Remove", role: .destructive) {
                            perform { _ = try await checkedRequest("/remote-settings/remove", body: ["connectionId": connectionID]); resetOwner(); try await load() }
                        }.disabled(creationStarted)
                    }
                    if owner != .null {
                        Text(owner["rootPath"].string ?? "").font(NativeStyle.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        ForEach(projects, id: \.selfID) { project in
                            Button { open(selected, project) } label: {
                                HStack {
                                    Image(systemName: "folder")
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(project["name"].string ?? "Project")
                                        Text(project["path"].string ?? "").font(NativeStyle.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer(); Image(systemName: "arrow.up.right")
                                }.padding(12).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                        Button("New project on this Mac", systemImage: "folder.badge.plus") { creating = true }
                    }
                }
                feedback
            }.padding(NativeStyle.pagePadding)
        }.font(NativeStyle.body).disabled(working || !client.connected)
        .task { perform { try await load() } }
        .sheet(isPresented: $importing) { NativeDetailPage(title: "Connect Mac") {
            Text("Use an existing SSH host and a private setup code from the owner Mac.").foregroundStyle(.secondary)
            TextField("Mac name", text: $label); TextField("SSH host", text: $host)
            SecureField("Complete private setup code", text: $code)
            Button("Save and verify") { perform(privateCode: true) {
                guard code.utf8.count <= 16384, let data = code.data(using: .utf8), let parsed = try? JSONDecoder().decode(JSON.self, from: data), parsed.objectValue != nil else { throw LocalError.message("Invalid code") }
                let saved = try await checkedRequest("/remote-settings/save", body: ["label": label, "sshHost": host, "code": parsed.any])
                code = ""; try await load(); connectionID = saved["id"].string ?? saved["connection"]["id"].string ?? ""
                owner = try await call("hello"); projects = (try await call("projects"))["projects"].array ?? []
                message = "Owner identity and setup grant verified."; importing = false
            } }.buttonStyle(.borderedProminent).disabled(label.isEmpty || host.isEmpty || code.isEmpty)
            feedback
        }.textFieldStyle(.roundedBorder).disabled(working || !client.connected).onDisappear { generation += 1; code = "" } }
        .sheet(isPresented: $sharing) { NativeDetailPage(title: "Share a setup folder") {
            Text("Allow the named source Mac to create projects and manage harness connections inside this folder.").foregroundStyle(.secondary)
            TextField("Source Mac ID", text: $sourceID)
            HStack { Text(rootPath.isEmpty ? "Choose a folder on this Mac" : rootPath).textSelection(.enabled); Spacer(); Button("Choose folder…") { selectingFolder = true } }
            Button("Create private setup code") { perform(privateCode: true) {
                exported = ""; let value = try await checkedRequest("/remote-settings/grant", body: ["sourceDeviceId": sourceID, "rootPath": rootPath]); exported = value.prettyText
            } }.buttonStyle(.borderedProminent).disabled(UUID(uuidString: sourceID) == nil || rootPath.isEmpty)
            if !exported.isEmpty { Text(exported).font(.system(.caption, design: .monospaced)).textSelection(.enabled); Button("Hide code") { exported = "" } }
            ForEach(settings["grants"].array ?? [], id: \.selfID) { grant in
                HStack { Text(grant["rootPath"].string ?? "Shared folder"); Spacer()
                    if grant["revoked"].bool == true { Text("Revoked") }
                    else { Button("Revoke", role: .destructive) { perform { _ = try await checkedRequest("/remote-settings/revoke", body: ["grantId": grant["id"].any]); exported = ""; try await load() } } }
                }
            }
            feedback
        }.textFieldStyle(.roundedBorder).disabled(working || !client.connected).onDisappear { generation += 1; exported = "" } }
        .fileImporter(isPresented: $selectingFolder, allowedContentTypes: [.folder]) { result in
            if case .success(let folder) = result { rootPath = folder.path }
        }
        .sheet(isPresented: $creating) { NativeDetailPage(title: "New project on \(selected["label"].string ?? "Mac")") {
            TextField("Project name", text: $projectName).disabled(creationStarted)
            TextField("Folder name", text: $folderName).disabled(creationStarted)
            Text("Created inside \(owner["rootPath"].string ?? "the shared folder").").font(NativeStyle.caption)
            Button(creationStarted ? "Retry same project request" : "Create project") { perform {
                if !creationStarted {
                    let name = projectName.trimmingCharacters(in: Self.javascriptWhitespace)
                    guard !name.isEmpty, name.utf16.count <= 120 else {
                        throw LocalError.message("Use a project name with 1 to 120 characters.")
                    }
                    guard folderName.range(of: "^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,119}$", options: .regularExpression) != nil,
                          folderName != ".", folderName != ".." else {
                        throw LocalError.message("Use a folder name with 1 to 120 characters. Start with a letter or number. Use letters, numbers, spaces, dots, underscores or hyphens.")
                    }
                    projectName = name; creationID = UUID().uuidString; creationConnection = connectionID; creationStarted = true
                }
                guard creationConnection == connectionID else { throw LocalError.message("Retry on the original owner Mac.") }
                let value = try await call("createProject", ["requestId": creationID, "name": projectName, "folderName": folderName])
                let project = value["project"]
                guard project["id"].string != nil else { throw LocalError.message("Project creation has not returned a project. Retry the same request.") }
                open(selected, project); creating = false; creationStarted = false; creationID = ""; creationConnection = ""; projectName = ""; folderName = ""
            } }.buttonStyle(.borderedProminent).disabled(projectName.isEmpty || folderName.isEmpty)
            if creationStarted {
                Button("Abandon this request…", role: .destructive) { abandoningCreation = true }
                    .confirmationDialog("Abandon this project request?", isPresented: $abandoningCreation, titleVisibility: .visible) {
                        Button("Abandon request", role: .destructive) {
                            creationStarted = false; creationID = ""; creationConnection = ""; failure = ""; message = "Request abandoned. Check the owner folder before creating another project."
                        }
                    } message: {
                        Text("The folder may already exist on the owner Mac. Inspect that folder first. Abandoning stops retries; it does not remove the folder or project.")
                    }
            }
            feedback
        }.textFieldStyle(.roundedBorder).disabled(working || !client.connected) }
        .sheet(isPresented: Binding(get: { openedProject != .null }, set: { if !$0 { openedProject = .null; openedConnection = .null } })) {
            NativeDetailPage(title: "Remote project") { NativeRemoteProjectView(client: client, connection: openedConnection, project: openedProject) }
        }
        .onDisappear { generation += 1; code = ""; exported = "" }
        .onChange(of: client.connected) { _, connected in if !connected { generation += 1; code = ""; exported = ""; resetOwner() } }
    }
    @ViewBuilder private var feedback: some View {
        if working { ProgressView("Contacting Mac…") }
        if !failure.isEmpty { Text(failure).foregroundStyle(.red).textSelection(.enabled) }
        if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
    }
    private func open(_ connection: JSON, _ project: JSON) {
        if let openProject { openProject(connection, project) }
        else { openedConnection = connection; openedProject = project }
    }
    private func resetOwner() { owner = .null; projects = [] }
    private func choose(_ item: JSON) { guard !creationStarted else { failure = "Retry the pending project request on this Mac first."; return }; generation += 1; connectionID = item["id"].string ?? ""; resetOwner(); failure = ""; message = "" }
    private func verify() { perform { owner = try await call("hello"); projects = (try await call("projects"))["projects"].array ?? []; message = "Owner identity and setup grant verified." } }
    private func load() async throws {
        settings = try await checkedRequest("/remote-settings")
        if creationStarted { connectionID = creationConnection }
    }
    private func checkedRequest(_ path: String, body: [String: Any]? = nil) async throws -> JSON {
        let scope = generation
        let value = try await client.request(path, body: body)
        guard scope == generation, client.connected else { throw CancellationError() }
        return value
    }
    private func call(_ operation: String, _ payload: [String: Any] = [:]) async throws -> JSON {
        try await checkedRequest("/remote-settings/\(NativeRemoteBoundary.component(connectionID))/call", body: ["operation": operation, "payload": payload])
    }
    private func perform(privateCode: Bool = false, _ action: @escaping @MainActor () async throws -> Void) {
        guard !working, client.connected else { return }
        let scope = generation; working = true; failure = ""; message = ""
        Task { defer { working = false }; do { try await action() } catch { if scope == generation { failure = privateCode ? "The private code could not be saved or verified. Check the source Mac ID, SSH host and complete code." : error.localizedDescription } } }
    }
}

struct NativeRemoteProjectView: View {
    @ObservedObject var client: AgentKlarClient
    let connection: JSON
    let project: JSON
    @State private var harness = "codex"
    @State private var owner: JSON = .null
    @State private var status: JSON = .null
    @State private var preview: JSON = .null
    @State private var working = false
    @State private var failure = ""
    @State private var message = ""
    @State private var generation = 0
    private var connectionID: String { connection["id"].string ?? "" }
    private var ownerHarnesses: [JSON] { owner["harnesses"].array ?? [] }
    private var verified: Bool { owner["device"]["id"].string != nil }
    private var availableHarness: Bool { verified && ownerHarnesses.contains { $0["id"].string == harness } }
    private var canApply: Bool {
        availableHarness && preview["id"].string != nil && preview["entry"].objectValue != nil
            && ["configured", "missing"].contains(status["status"].string ?? "")
    }
    var body: some View {
        ScrollView { VStack(alignment: .leading, spacing: 20) {
            NativeSectionTitle(title: project["name"].string ?? "Remote project", subtitle: "Owned by \(connection["label"].string ?? "another Mac")")
            Text(project["path"].string ?? "").foregroundStyle(.secondary).textSelection(.enabled)
            Text("Connect a coding app on the owner Mac. Open its native session in this project after applying the connection.")
            if verified {
                LabeledContent("Verified owner", value: owner["device"]["label"].string ?? "Mac")
                Text(owner["device"]["id"].string ?? "").font(NativeStyle.caption).textSelection(.enabled)
            } else {
                Text("Verify the owner Mac before choosing a coding app or changing its connection.").foregroundStyle(.secondary)
            }
            Button(verified ? "Verify owner again" : "Verify owner Mac") { run("setupStatus", verify: true) }
            Picker("Coding app", selection: $harness) {
                Text("Choose an owner coding app").tag("")
                ForEach(ownerHarnesses, id: \.selfID) { item in Text(item["name"].string ?? item["id"].string ?? "Coding app").tag(item["id"].string ?? "") }
            }.disabled(!verified)
            LabeledContent("Connection status", value: status["status"].string ?? "Not checked")
            if let detail = status["message"].string { Text(detail).foregroundStyle(status["status"].string == "conflict" ? Color.orange : Color.secondary).textSelection(.enabled) }
            if let path = status["configPath"].string { Text(path).font(NativeStyle.caption).textSelection(.enabled) }
            HStack { Button("Refresh status") { run("setupStatus") }; Button("Review connection") { run("setupPreview") }.buttonStyle(.borderedProminent)
                if status["canUndo"].bool == true { Button("Remove managed connection", role: .destructive) { run("setupUndo") } }
            }.disabled(!availableHarness)
            if preview != .null { GroupBox("Review connection on owner Mac") { VStack(alignment: .leading, spacing: 12) {
                Text(preview["configPath"].string ?? "Config path unavailable").textSelection(.enabled)
                Text("Scope: \(preview["scope"].string ?? "Unknown")")
                if preview["scope"].string == "User" {
                    Text("This changes the coding app's user settings on the owner Mac. The connection applies across its projects.").foregroundStyle(.orange)
                }
                if let cwd = preview["cwd"].string { Text("Project folder: " + cwd).textSelection(.enabled) }
                if let date = preview["createdAt"].string { Text("Reviewed preview created: " + date).font(NativeStyle.caption) }
                Text(preview["command"].string ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                Text(preview["entry"].prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                HStack { Button("Apply connection") { run("setupApply") }.buttonStyle(.borderedProminent).disabled(!canApply); Button("Cancel") { preview = .null } }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(12) } }
            if working { ProgressView("Contacting owner Mac…") }
            if !failure.isEmpty { Text(failure).foregroundStyle(.red).textSelection(.enabled) }
            if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
        }.padding(NativeStyle.pagePadding).frame(maxWidth: .infinity, alignment: .leading) }.font(NativeStyle.body).disabled(working || !client.connected)
        .task { run("setupStatus", verify: true) }
        .onChange(of: harness) { _, _ in generation += 1; status = .null; preview = .null; run("setupStatus") }
        .onDisappear { generation += 1; preview = .null }
        .onChange(of: client.connected) { _, connected in if !connected { generation += 1; owner = .null; status = .null; preview = .null } }
    }
    private func checkedRequest(_ path: String, body: [String: Any]? = nil) async throws -> JSON {
        let scope = generation
        let value = try await client.request(path, body: body)
        guard scope == generation, client.connected else { throw CancellationError() }
        return value
    }
    private func call(_ operation: String, payload: [String: Any]) async throws -> JSON {
        try await checkedRequest("/remote-settings/\(NativeRemoteBoundary.component(connectionID))/call", body: ["operation": operation, "payload": payload])
    }
    private func run(_ operation: String, verify: Bool = false) {
        guard !working, client.connected, verify || availableHarness else { return }
        let scope = generation; let selectedHarness = harness
        var payload: [String: Any] = ["projectId": project["id"].any, "harness": selectedHarness]
        if operation == "setupApply" { guard canApply, let id = preview["id"].string else { return }; payload["previewId"] = id }
        if operation == "setupUndo" { guard status["canUndo"].bool == true, let id = status["change"]["id"].string else { return }; payload["changeId"] = id }
        working = true; failure = ""; message = ""
        Task { defer { working = false }; do {
            if verify {
                owner = .null; status = .null; preview = .null
                let value = try await call("hello", payload: [:]); guard scope == generation else { return }; owner = value
                guard availableHarness else { message = "Owner verified. Choose a coding app installed on that Mac."; return }
            }
            if operation == "setupPreview" {
                let current = try await call("setupStatus", payload: payload)
                guard scope == generation, client.connected else { return }
                status = current; preview = .null
                guard ["configured", "missing"].contains(current["status"].string ?? "") else {
                    throw LocalError.message(current["message"].string ?? "Resolve the owner connection before reviewing setup.")
                }
            }
            let value = try await call(operation, payload: payload); guard scope == generation, client.connected else { return }
            if operation == "setupPreview" { preview = value }
            else if operation == "setupStatus" { status = value; preview = .null }
            else { preview = .null; let value = try await call("setupStatus", payload: ["projectId": project["id"].any, "harness": selectedHarness]); guard scope == generation else { return }; status = value; message = "Owner connection changed. Restart the coding app session on that Mac to load it." }
        } catch { if scope == generation { failure = error.localizedDescription; preview = .null } } }
    }
}
