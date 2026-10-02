import SwiftUI
import AppKit

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
                    .formStyle(.grouped).font(.system(size: 13)).padding(20).tabItem { Label("Skills and plugins", systemImage: "puzzlepiece.extension") }
            }.padding(20)
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
                Text("Shared context for your native harness and new workers.").foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let revision { Text("Revision \(revision)").font(.caption).foregroundStyle(.secondary) }
            }
            Section("Brief") { ProjectTextEditor(text: $brief, label: "Project brief", height: 120) }
            Section("Memory") { ProjectTextEditor(text: $memory, label: "Decisions and memory", height: 150) }
            Section("Next steps") { ProjectTextEditor(text: $handoff, label: "Next steps", height: 120) }
            Section {
                if !message.isEmpty { Text(message).foregroundStyle(failed ? .red : .secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { contextActions }.fixedSize(horizontal: true, vertical: false)
                    VStack(alignment: .leading, spacing: 12) { contextActions }
                }
            }
            Section {
                DisclosureGroup("Switch main harness") { NativeProjectHandoffView(client: client).padding(.top, 12) }
            }
        }.formStyle(.grouped).font(.system(size: 13)).padding(20).disabled(busy || !client.connected)
        .confirmationDialog("Replace this draft with the latest saved context?", isPresented: $reload, titleVisibility: .visible) {
            Button("Reload latest") { Task { await load() } }; Button("Cancel", role: .cancel) {}
        }
        .task(id: client.projectID) { await load() }
    }
    @ViewBuilder private var contextActions: some View {
        Button("Reload latest…") { reload = true }
        Button("Save context") { Task { await save() } }.disabled(revision == nil || loadedProject != client.projectID)
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
                Text("Project instruction files").foregroundStyle(.secondary)
                DisclosureGroup("Details") {
                    Text("Edit the root AGENTS.md or CLAUDE.md. Native trust, parent files and active sessions can affect which instructions load.").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Picker("File", selection: $file) { Text("AGENTS.md").tag("agents"); Text("CLAUDE.md").tag("claude") }.disabled(dirty || busy)
                if let metadata = (inventory["files"].array ?? []).first(where: { $0["id"].string == file }) {
                    Text(metadata["path"].string ?? "").font(.caption).lineLimit(3).truncationMode(.middle).textSelection(.enabled)
                    Text(metadata["message"].string ?? metadata["status"].string ?? "Status unknown").font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { fileActions }.fixedSize(horizontal: true, vertical: false)
                    VStack(alignment: .leading, spacing: 12) { fileActions }
                }
            }
            if document["text"].string != nil {
                Section(file == "agents" ? "AGENTS.md" : "CLAUDE.md") {
                    ProjectTextEditor(text: $draft, label: file == "agents" ? "AGENTS.md source" : "CLAUDE.md source", height: 300, source: true)
                    Text("\(draft.utf8.count) / 32,768 UTF-8 bytes").font(.caption).foregroundStyle(.secondary)
                    Button("Preview changes") { Task { await propose() } }.disabled(conflict || draft.utf8.count > 32768)
                }
            }
            if let previewID = preview["id"].string {
                Section("Review exact change") {
                    Text(preview["path"].string ?? "").font(.system(size: 11)).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    GroupBox("Before") { previewText(preview["before"].string ?? "File does not exist.") }
                    GroupBox("After") { previewText(preview["after"].string ?? "") }
                    Text("Start a new native session to check which instructions load.").font(.system(size: 11)).foregroundStyle(.secondary)
                    Button("Apply this change") { Task { await change(previewID: previewID) } }.disabled(preview["before"].string == preview["after"].string)
                }
            }
            if !message.isEmpty { Section { Text(message).foregroundStyle(failed ? .red : .secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) } }
            Section("Recent changes") {
                ForEach(changes, id: \.selfID) { change in
                    VStack(alignment: .leading, spacing: 12) {
                        Text("\(change["operation"].string ?? "Change") · \(change["state"].string ?? "Unknown")")
                        if let message = change["message"].string { Text(message).font(.caption).foregroundStyle(.secondary) }
                        if change["state"].string == "interrupted" {
                            Button("Try undo unchanged file") { Task { await self.change(undo: change) } }.disabled(dirty || document["text"].string == nil)
                        }
                    }
                }
            }
        }.formStyle(.grouped).font(.system(size: 13)).padding(20).disabled(busy || !client.connected)
        .task(id: "\(client.projectID):\(file)") {
            document = .null; preview = .null; draft = ""; conflict = false; message = ""
            await refreshInventory()
        }
        .onChange(of: draft) { _, _ in preview = .null }
        .confirmationDialog("Replace this draft with the current native file?", isPresented: $reload, titleVisibility: .visible) {
            Button("Reload file") { Task { await load() } }; Button("Cancel", role: .cancel) {}
        }
    }
    private func previewText(_ text: String) -> some View {
        Text(text).font(.system(size: 13, design: .monospaced)).fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(8)
    }
    @ViewBuilder private var fileActions: some View {
        Button(document["text"].string == nil ? "Load file" : "Reload file…") {
            if dirty { reload = true } else { Task { await load() } }
        }
        if let latest { Button("Undo latest change") { Task { await change(undo: latest) } }.disabled(dirty || document["text"].string == nil) }
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


private struct ProjectTextEditor: View {
    @Binding var text: String
    let label: String
    let height: CGFloat
    var source = false
    var body: some View {
        TextEditor(text: $text).font(source ? .system(size: 13, design: .monospaced) : .system(size: 13))
            .scrollContentBackground(.hidden).padding(8).frame(height: height)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            .accessibilityLabel(label)
    }
}
