import SwiftUI
import AppKit

struct ProjectDetailsView: View {
    @ObservedObject var client: AgentKlarClient
    let section: String
    @State private var instructionMode = "Files"
    var body: some View {
        if section == "Instructions" {
            VStack(alignment: .leading, spacing: 0) {
                VStack(alignment: .leading, spacing: 20) {
                    NativePageHeader(title: "Instructions", subtitle: "Files, skills and plugins for your coding apps.") {}
                    NativePageTabs(selection: $instructionMode, items: ["Files", "Skills and plugins"])
                }.frame(maxWidth: NativeStyle.contentWidth).padding(.horizontal, NativeStyle.pagePadding)
                    .padding(.top, NativeStyle.pagePadding).frame(maxWidth: .infinity)
                GeometryReader { space in
                    ZStack {
                    Group {
                        if client.projectID.isEmpty {
                            ContentUnavailableView("Choose a project", systemImage: "folder", description: Text("Instruction files belong to an existing project."))
                        } else { NativeInstructionEditor(client: client) }
                    }.frame(width: space.size.width, height: space.size.height, alignment: .topLeading)
                        .opacity(instructionMode == "Files" ? 1 : 0).disabled(instructionMode != "Files")
                        .allowsHitTesting(instructionMode == "Files").accessibilityElement(children: .contain).accessibilityHidden(instructionMode != "Files")
                    ScrollView {
                        NativeExtensionsView(client: client).frame(maxWidth: NativeStyle.contentWidth, alignment: .leading)
                            .padding(NativeStyle.pagePadding).frame(maxWidth: .infinity)
                    }
                        .font(NativeStyle.body).frame(width: space.size.width, height: space.size.height, alignment: .topLeading)
                        .opacity(instructionMode == "Skills and plugins" ? 1 : 0)
                        .disabled(instructionMode != "Skills and plugins").allowsHitTesting(instructionMode == "Skills and plugins")
                        .accessibilityElement(children: .contain).accessibilityHidden(instructionMode != "Skills and plugins")
                    }.frame(width: space.size.width, height: space.size.height, alignment: .topLeading).clipped()
                }
            }
        } else if client.projectID.isEmpty {
            ContentUnavailableView("Choose a project", systemImage: "folder", description: Text("Project context and instruction files belong to an existing project."))
        } else {
            NativeContextEditor(client: client)
        }
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
        VStack(alignment: .leading, spacing: 12) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { fileSelector; fileActions }.fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 8) { fileSelector; fileActions }
            }
            if let metadata = (inventory["files"].array ?? []).first(where: { $0["id"].string == file }) {
                Text(metadata["path"].string ?? "").font(NativeStyle.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.middle).help(metadata["path"].string ?? "").textSelection(.enabled)
                Text(metadata["message"].string ?? metadata["status"].string ?? "Status unknown")
                    .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if document["text"].string != nil {
                TextEditor(text: $draft).font(NativeStyle.source).lineSpacing(4)
                    .scrollContentBackground(.hidden)
                    .padding(20).frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: NativeStyle.cornerRadius))
                    .overlay(RoundedRectangle(cornerRadius: NativeStyle.cornerRadius).strokeBorder(.quaternary))
                    .accessibilityLabel(file == "agents" ? "AGENTS.md source" : "CLAUDE.md source")
            } else {
                ContentUnavailableView("Load an instruction file", systemImage: "doc.text", description: Text("Choose AGENTS.md or CLAUDE.md, then Load file to read its current contents."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            if !message.isEmpty { Text(message).foregroundStyle(failed ? .red : .secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) { documentActions; Spacer(); documentCount }
                VStack(alignment: .leading, spacing: 12) { documentActions; documentCount }
            }
        }.font(NativeStyle.body).controlSize(.regular).frame(maxWidth: NativeStyle.contentWidth, maxHeight: .infinity)
            .padding(NativeStyle.pagePadding).frame(maxWidth: .infinity, maxHeight: .infinity).disabled(busy || !client.connected)
        .task(id: "\(client.projectID):\(file)") {
            document = .null; preview = .null; draft = ""; conflict = false; message = ""
            await refreshInventory()
            if !Task.isCancelled { await load() }
        }
        .onChange(of: draft) { _, _ in preview = .null }
        .confirmationDialog("Replace this draft with the current native file?", isPresented: $reload, titleVisibility: .visible) {
            Button("Reload file") { Task { await load() } }; Button("Cancel", role: .cancel) {}
        }
    }
    private var fileSelector: some View {
        Picker("File", selection: $file) {
            Text("AGENTS.md").tag("agents")
            Text("CLAUDE.md").tag("claude")
        }.disabled(dirty || busy).fixedSize(horizontal: true, vertical: false)
    }
    @ViewBuilder private var documentCount: some View {
        if document["text"].string != nil {
            Text("\(draft.utf8.count.formatted()) / 32,768 bytes").font(NativeStyle.caption).foregroundStyle(.secondary)
        }
    }
    @ViewBuilder private var documentActions: some View {
        if document["text"].string != nil {
            Button("Preview changes", systemImage: "doc.text.magnifyingglass") { Task { await propose() } }
                .buttonStyle(.borderedProminent).disabled(!dirty || conflict || draft.utf8.count > 32768)
        }
        if let previewID = preview["id"].string {
            NativeDetailButton("Review exact change") {
                VStack(alignment: .leading, spacing: 12) {
                    Text(preview["path"].string ?? "").font(NativeStyle.caption).textSelection(.enabled)
                    Text("Before").font(NativeStyle.heading)
                    previewText(preview["before"].string ?? "File does not exist.")
                    Divider()
                    Text("After").font(NativeStyle.heading)
                    previewText(preview["after"].string ?? "")
                    Text("Start a new native session to check which instructions load.").font(NativeStyle.caption).foregroundStyle(.secondary)
                    Button("Apply this change") { Task { await change(previewID: previewID) } }
                        .disabled(preview["before"].string == preview["after"].string)
                }.disabled(busy || !client.connected)
            }.id(previewID)
        }
        NativeDetailButton("Recent changes") {
            VStack(alignment: .leading, spacing: 12) {
                if changes.isEmpty { Text("No recent changes for this file.").foregroundStyle(.secondary) }
                ForEach(changes, id: \.selfID) { change in
                    Text("\(change["operation"].string ?? "Change") · \(change["state"].string ?? "Unknown")").font(NativeStyle.heading)
                    if let message = change["message"].string { Text(message).foregroundStyle(.secondary) }
                    if change["state"].string == "interrupted" {
                        Button("Try undo unchanged file") { Task { await self.change(undo: change) } }
                            .disabled(dirty || document["text"].string == nil)
                    }
                    Divider()
                }
            }.disabled(busy || !client.connected)
        }.id("history:" + file)
        NativeDetailButton("About instruction files") {
            Text("Edit the root AGENTS.md or CLAUDE.md. Native trust, parent files and active sessions can affect which instructions load.")
                .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
    private func previewText(_ text: String) -> some View {
        Text(text).font(NativeStyle.source).fixedSize(horizontal: false, vertical: true)
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
        TextEditor(text: $text).font(source ? .system(size: 15, design: .monospaced) : .system(size: 15))
            .scrollContentBackground(.hidden).padding(8).frame(height: height)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(.quaternary))
            .accessibilityLabel(label)
    }
}


/// Long supporting records open separately from the main editing surface.
struct NativeDetailButton<Content: View>: View {
    let title: String
    let content: Content
    @State private var showing = false
    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title; self.content = content()
    }
    var body: some View {
        Button(title + "…") { showing = true }.buttonStyle(.plain).foregroundStyle(.tint)
            .sheet(isPresented: $showing) { NativeDetailPage(title: title) { content } }
    }
}

struct NativeDetailPage<Content: View>: View {
    let title: String
    let height: CGFloat
    let content: Content
    @Environment(\.dismiss) private var dismiss
    init(title: String, height: CGFloat = 560, @ViewBuilder content: () -> Content) {
        self.title = title; self.height = height; self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack { Text(title).font(NativeStyle.heading); Spacer(); Button("Done") { dismiss() }.keyboardShortcut(.cancelAction) }
            Divider()
            ScrollView { VStack(alignment: .leading, spacing: 12) { content }.frame(maxWidth: .infinity, alignment: .leading) }
        }.font(NativeStyle.body).foregroundStyle(.primary).controlSize(.regular)
            .padding(NativeStyle.pagePadding).frame(width: 640, height: height)
    }
}
