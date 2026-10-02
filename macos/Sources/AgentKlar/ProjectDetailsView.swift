import SwiftUI

struct ProjectDetailsView: View {
    @ObservedObject var client: AgentKlarClient
    let section: String
    var body: some View {
        if section == "Instructions" {
            TabView {
                Group {
                    if client.projectID.isEmpty {
                        ContentUnavailableView("Choose a project", systemImage: "folder", description: Text("Instruction files belong to an existing project."))
                    } else { NativeInstructionEditor(client: client) }
                }.tabItem { Label("Files", systemImage: "doc.text") }
                Form { Section("Skills and plugins") { NativeExtensionsView(client: client) } }
                    .formStyle(.grouped).tabItem { Label("Skills and plugins", systemImage: "puzzlepiece.extension") }
            }.padding()
        } else if client.projectID.isEmpty {
            ContentUnavailableView("Choose a project", systemImage: "folder", description: Text("Project context and instruction files belong to an existing project."))
        } else {
            NativeContextEditor(client: client)
        }
    }
}

private struct NativeContextEditor: View {
    @ObservedObject var client: AgentKlarClient
    @State private var revision: Int?
    @State private var loadedProject = ""
    @State private var brief = ""
    @State private var memory = ""
    @State private var handoff = ""
    @State private var busy = false
    @State private var message = ""
    @State private var failed = false
    @State private var reload = false
    var body: some View {
        Form {
            Section {
                Text("Shared project context").font(.title2.weight(.semibold))
                Text("Save the brief, decisions and next steps for your native harness and new workers.").foregroundStyle(.secondary)
                if let revision { Text("Revision \(revision)").font(.caption).foregroundStyle(.secondary) }
            }
            Section("Project brief") { TextEditor(text: $brief).frame(minHeight: 100) }
            Section("Decisions and memory") { TextEditor(text: $memory).frame(minHeight: 130) }
            Section("Next steps") { TextEditor(text: $handoff).frame(minHeight: 100) }
            Section {
                if !message.isEmpty { Text(message).foregroundStyle(failed ? .red : .secondary).textSelection(.enabled) }
                HStack {
                    Button("Reload latest…") { reload = true }
                    Spacer()
                    Button("Save context") { Task { await save() } }.disabled(revision == nil || loadedProject != client.projectID)
                }
            }
        }.formStyle(.grouped).disabled(busy || !client.connected)
        .confirmationDialog("Replace this draft with the latest saved context?", isPresented: $reload, titleVisibility: .visible) {
            Button("Reload latest") { Task { await load() } }; Button("Cancel", role: .cancel) {}
        }
        .task(id: client.projectID) { await load() }
    }
    private func load() async {
        let id = client.projectID; guard !id.isEmpty else { return }
        busy = true; message = ""; failed = false
        do {
            let value = try await client.request("/projects/\(id)/context")
            guard client.projectID == id else { busy = false; return }
            revision = value["revision"].number.map(Int.init); loadedProject = id
            brief = value["brief"].string ?? ""; memory = value["memory"].string ?? ""; handoff = value["handoff"].string ?? ""
        } catch { failed = true; message = error.localizedDescription }
        busy = false
    }
    private func save() async {
        guard !busy, let revision, loadedProject == client.projectID else { return }
        busy = true; message = ""; failed = false
        let id = loadedProject
        do {
            let value = try await client.request("/projects/\(id)/context", body: ["brief": brief, "memory": memory, "handoff": handoff, "expectedRevision": revision], method: "PUT")
            if client.projectID == id { self.revision = value["revision"].number.map(Int.init); message = "Context saved." }
        } catch { failed = true; message = "\(error.localizedDescription) Your draft is still here. Reload latest to replace it before retrying." }
        busy = false
    }
}

private struct NativeInstructionEditor: View {
    @ObservedObject var client: AgentKlarClient
    @State private var file = "agents"
    @State private var inventory: JSON = .null
    @State private var document: JSON = .null
    @State private var preview: JSON = .null
    @State private var draft = ""
    @State private var loadedProject = ""
    @State private var busy = false
    @State private var message = ""
    @State private var failed = false
    @State private var conflict = false
    @State private var reload = false
    private var dirty: Bool { document["text"].string != nil && draft != document["text"].string }
    private var changes: [JSON] { (inventory["changes"].array ?? []).filter { $0["file"].string == file } }
    private var latest: JSON? { changes.first { $0["state"].string == "applied" && $0["operation"].string == "apply" } }
    var body: some View {
        Form {
            Section {
                Text("Native project instructions").font(.title2.weight(.semibold))
                Text("Edit this project's root AGENTS.md or CLAUDE.md. Native trust, parent files and active sessions can affect what loads.").foregroundStyle(.secondary)
                Picker("File", selection: $file) { Text("AGENTS.md").tag("agents"); Text("CLAUDE.md").tag("claude") }.disabled(dirty || busy)
                if let metadata = (inventory["files"].array ?? []).first(where: { $0["id"].string == file }) {
                    Text(metadata["path"].string ?? "").font(.caption).textSelection(.enabled)
                    Text(metadata["message"].string ?? metadata["status"].string ?? "Status unknown").foregroundStyle(.secondary)
                }
                HStack {
                    Button(document["text"].string == nil ? "Load file" : "Reload file…") {
                        if dirty { reload = true } else { Task { await load() } }
                    }
                    if let latest { Button("Undo latest change") { Task { await change(undo: latest) } }.disabled(dirty || document["text"].string == nil) }
                }
            }
            if document["text"].string != nil {
                Section(file == "agents" ? "AGENTS.md" : "CLAUDE.md") {
                    TextEditor(text: $draft).font(.system(.body, design: .monospaced)).frame(minHeight: 240)
                    Text("\(draft.utf8.count) / 32,768 UTF-8 bytes").font(.caption).foregroundStyle(.secondary)
                    Button("Preview changes") { Task { await propose() } }.disabled(conflict || draft.utf8.count > 32768)
                }
            }
            if let previewID = preview["id"].string {
                Section("Exact proposed change") {
                    Text(preview["path"].string ?? "").font(.caption).textSelection(.enabled)
                    Text("Before").font(.headline)
                    Text(preview["before"].string ?? "File does not exist.").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Text("After").font(.headline)
                    Text(preview["after"].string ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Text("Creating either file can change which native instructions load. Start a new native session to check.").font(.caption).foregroundStyle(.secondary)
                    Button("Apply this change") { Task { await change(previewID: previewID) } }.disabled(preview["before"].string == preview["after"].string)
                }
            }
            if !message.isEmpty { Section { Text(message).foregroundStyle(failed ? .red : .secondary).textSelection(.enabled) } }
            Section("Recent changes") {
                ForEach(changes, id: \.selfID) { change in
                    VStack(alignment: .leading) {
                        Text("\(change["operation"].string ?? "Change") · \(change["state"].string ?? "Unknown")")
                        if let message = change["message"].string { Text(message).font(.caption).foregroundStyle(.secondary) }
                        if change["state"].string == "interrupted" {
                            Button("Try undo unchanged file") { Task { await self.change(undo: change) } }.disabled(dirty || document["text"].string == nil)
                        }
                    }
                }
            }
        }.formStyle(.grouped).disabled(busy || !client.connected)
        .task(id: "\(client.projectID):\(file)") {
            document = .null; preview = .null; draft = ""; conflict = false; message = ""
            await refreshInventory()
        }
        .onChange(of: draft) { _, _ in preview = .null }
        .confirmationDialog("Replace this draft with the current native file?", isPresented: $reload, titleVisibility: .visible) {
            Button("Reload file") { Task { await load() } }; Button("Cancel", role: .cancel) {}
        }
    }
    private func refreshInventory() async {
        let id = client.projectID
        guard !id.isEmpty else { return }
        do { let value = try await client.request("/projects/\(id)/instructions"); if id == client.projectID { inventory = value } }
        catch { failed = true; message = error.localizedDescription }
    }
    private func load() async {
        busy = true; message = ""; failed = false
        let id = client.projectID, selectedFile = file
        do {
            let value = try await client.request("/projects/\(id)/instructions/\(selectedFile)")
            if id == client.projectID && file == selectedFile { document = value; draft = value["text"].string ?? ""; loadedProject = id; preview = .null; conflict = false }
        } catch { failed = true; message = error.localizedDescription }
        busy = false
    }
    private func propose() async {
        guard !busy, !conflict, loadedProject == client.projectID, draft.utf8.count <= 32768 else { return }
        busy = true; failed = false; message = ""
        let id = loadedProject, selectedFile = file, text = draft
        do {
            let value = try await client.request("/projects/\(id)/instructions/preview", body: ["file": selectedFile, "text": text, "expectedHash": document["hash"].any])
            if id == client.projectID && selectedFile == file && draft == text { preview = value }
        } catch { failed = true; conflict = true; preview = .null; message = "\(error.localizedDescription) Draft kept. Reload the file before retrying." }
        busy = false
    }
    private func change(previewID: String? = nil, undo: JSON? = nil) async {
        guard !busy, loadedProject == client.projectID, undo == nil || !dirty else { return }
        busy = true; failed = false; message = ""
        let id = loadedProject, selectedFile = file
        do {
            let body: [String: Any] = undo != nil ? ["changeId": undo!["id"].string ?? ""] : ["previewId": previewID ?? ""]
            _ = try await client.request("/projects/\(id)/instructions/\(undo != nil ? "rollback" : "apply")", body: body)
            if id == client.projectID && selectedFile == file { preview = .null; await load(); await refreshInventory(); message = undo != nil ? "Change undone." : "Instruction file saved." }
        } catch { failed = true; conflict = true; preview = .null; message = "\(error.localizedDescription) Draft kept. Reload current file before retrying." }
        busy = false
    }
}
