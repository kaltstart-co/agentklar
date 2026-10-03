import SwiftUI
import AppKit

struct NativeContextEditor: View {
    @ObservedObject var client: AgentKlarClient
    @State private var revision: Int?
    @State private var loadedProject = ""
    @State private var generation = UUID()
    @State private var brief = ""
    @State private var memory = ""
    @State private var handoff = ""
    @State private var busy = false
    @State private var message = ""
    @State private var failed = false
    @State private var reload = false
    @State private var selectedDocument = "Brief"
    @State private var selectedEntry = -1
    @State private var search = ""
    @State private var fullMemory = false
    @State private var showingHandoff = false
    @State private var addingEntry = false
    @State private var editingEntry: Int?
    @State private var confirmingDelete = false
    @State private var newTitle = ""
    @State private var newBody = ""

    private var ready: Bool { revision != nil && loadedProject == client.projectID }
    private var memoryDocument: NativeMemoryDocument { NativeMemoryDocument(memory) }
    private var entryBinding: Binding<String> {
        Binding(get: { memoryDocument.body(selectedEntry) }, set: { memory = memoryDocument.replacingBody(selectedEntry, with: $0) })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            NativePageHeader(title: "Context", subtitle: "Project brief, useful memories and the next steps for your agents.") { contextActions }
            if !message.isEmpty {
                Text(message).foregroundStyle(failed ? .red : .secondary).textSelection(.enabled)
            }
            NativePageTabs(selection: $selectedDocument, items: ["Brief", "Memory", "Next steps"])
            VStack(alignment: .leading, spacing: 16) {
                if selectedDocument == "Memory" { memoryWorkspace }
                else {
                    Text(selectedDocument == "Brief" ? "Project purpose and direction" : "Work to pick up next")
                        .font(NativeStyle.caption).foregroundStyle(.secondary)
                    documentEditor(selectedDocument == "Brief" ? $brief : $handoff, label: selectedDocument)
                }
            }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            HStack {
                Text(revision.map { "Saved revision \($0)" } ?? "Loading context…")
                Spacer()
                Button("Switch main harness…") { showingHandoff = true }.buttonStyle(.plain).foregroundStyle(.tint)
            }.font(NativeStyle.caption).foregroundStyle(.secondary)
        }.font(NativeStyle.body).padding(NativeStyle.pagePadding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .disabled(busy || !client.connected)
            .sheet(isPresented: $showingHandoff) {
                NativeDetailPage(title: "Switch main harness") { NativeProjectHandoffView(client: client) }
            }
            .sheet(isPresented: $addingEntry) { addEntrySheet }
            .confirmationDialog("Replace this draft with the latest saved context?", isPresented: $reload, titleVisibility: .visible) {
                Button("Reload latest") { Task { await load() } }
                Button("Cancel", role: .cancel) {}
            }
            .confirmationDialog("Delete this memory from your draft?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete memory", role: .destructive) {
                    memory = memoryDocument.removing(selectedEntry)
                    selectedEntry = memoryDocument.entries.first?.id ?? -1
                }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Save context to share the deletion with your agents.") }
            .task(id: client.projectID) {
                generation = UUID()
                addingEntry = false; showingHandoff = false; confirmingDelete = false
                await load()
            }
    }

    private var memoryWorkspace: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("Memory").font(NativeStyle.heading)
                Spacer()
                Button(fullMemory ? "Show entries" : "Edit full document") { fullMemory.toggle() }
                    .buttonStyle(.plain).foregroundStyle(.tint)
                Button("Add memory", systemImage: "plus") { editingEntry = nil; newTitle = ""; newBody = ""; addingEntry = true }
                    .buttonStyle(.borderedProminent).disabled(!ready)
            }
            if fullMemory {
                Text("Read or edit all saved notes together.").font(NativeStyle.caption).foregroundStyle(.secondary)
                documentEditor($memory, label: "Full memory document")
            } else {
                GeometryReader { space in
                    if space.size.width >= 650 {
                        HStack(alignment: .top, spacing: 20) {
                            memoryList.frame(width: 240)
                            Divider()
                            memoryEditor
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 16) {
                            memoryList.frame(height: min(180, space.size.height * 0.35))
                            Divider()
                            memoryEditor
                        }
                    }
                }
            }
        }
    }

    private var memoryList: some View {
        VStack(alignment: .leading, spacing: 12) {
            NativeSearchField(placeholder: "Search memories", text: $search)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if memoryDocument.prefixRange.length > 0 || memoryDocument.entries.isEmpty {
                        memoryRow(-1, title: "Existing notes", body: memoryDocument.body(-1))
                    }
                    ForEach(memoryDocument.entries) { entry in
                        memoryRow(entry.id, title: entry.title, body: memoryDocument.body(entry.id))
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var memoryEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(selectedEntry == -1 ? "Existing notes" : memoryDocument.entries.first(where: { $0.id == selectedEntry })?.title ?? "Choose a memory")
                    .font(NativeStyle.heading).lineLimit(2)
                Spacer()
                if let entry = memoryDocument.entries.first(where: { $0.id == selectedEntry }) {
                    Button("Edit title…") {
                        editingEntry = entry.id; newTitle = entry.title; newBody = memoryDocument.body(entry.id); addingEntry = true
                    }.buttonStyle(.plain).foregroundStyle(.tint).disabled(!ready)
                    Button { confirmingDelete = true } label: { Image(systemName: "trash") }
                        .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Delete memory").disabled(!ready)
                }
            }
            if selectedEntry == -1 || memoryDocument.entries.contains(where: { $0.id == selectedEntry }) {
                documentEditor(entryBinding, label: "Memory entry")
            } else {
                Text("Choose a memory to read or edit it.").foregroundStyle(.secondary)
                Spacer()
            }
        }.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder private func memoryRow(_ id: Int, title: String, body: String) -> some View {
        if search.isEmpty || title.localizedCaseInsensitiveContains(search) || body.localizedCaseInsensitiveContains(search) {
            Button { selectedEntry = id } label: {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).fontWeight(.medium)
                    Text(body.isEmpty ? "No notes yet" : body).font(NativeStyle.caption).foregroundStyle(.secondary).lineLimit(3)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .background(selectedEntry == id ? Color.accentColor.opacity(0.1) : Color.primary.opacity(0.03), in: RoundedRectangle(cornerRadius: NativeStyle.cornerRadius))
            }.buttonStyle(.plain)
        }
    }

    private func documentEditor(_ binding: Binding<String>, label: String) -> some View {
        TextEditor(text: binding).font(NativeStyle.document).lineSpacing(5)
            .scrollContentBackground(.hidden).padding(20)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: NativeStyle.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: NativeStyle.cornerRadius).strokeBorder(.quaternary))
            .accessibilityLabel(label).disabled(!ready)
    }

    private var addEntrySheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack { Text(editingEntry == nil ? "Add memory" : "Edit memory").font(NativeStyle.heading); Spacer(); Button("Cancel") { addingEntry = false }.keyboardShortcut(.cancelAction) }
            Text("Title").fontWeight(.medium)
            TextField("A decision, lesson or project fact", text: $newTitle).textFieldStyle(.roundedBorder)
            Text("Notes").fontWeight(.medium)
            TextEditor(text: $newBody).font(NativeStyle.document).lineSpacing(5).frame(maxWidth: .infinity, maxHeight: .infinity)
            HStack { Text("Added to your draft. Save context to share it.").foregroundStyle(.secondary); Spacer()
                Button(editingEntry == nil ? "Add to memory" : "Apply to draft") {
                    let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "\n", with: " ").replacingOccurrences(of: "\r", with: " ")
                    if let editingEntry {
                        memory = memoryDocument.replacingBody(editingEntry, with: newBody)
                        memory = memoryDocument.renaming(editingEntry, to: title)
                        selectedEntry = editingEntry
                    } else {
                        let entryID = memoryDocument.entries.count
                        memory += (memory.isEmpty ? "" : "\n\n") + "## " + title + "\n" + newBody
                        selectedEntry = entryID
                    }
                    fullMemory = false; addingEntry = false
                }.buttonStyle(.borderedProminent).disabled(newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !ready)
            }
        }.font(NativeStyle.body).padding(28).frame(minWidth: 760, idealWidth: 900, minHeight: 560, idealHeight: 680)
    }

    @ViewBuilder private var contextActions: some View {
        Button { reload = true } label: { Image(systemName: "arrow.clockwise") }
            .buttonStyle(.plain).foregroundStyle(.secondary).help("Reload saved context…").accessibilityLabel("Reload saved context")
        Button("Save context") { Task { await save() } }.buttonStyle(.borderedProminent).disabled(!ready)
    }

    private func load() async {
        let id = client.projectID, captured = generation
        guard !id.isEmpty else { return }
        busy = true; message = ""; failed = false
        if loadedProject != id { revision = nil }
        do {
            let value = try await client.request("/projects/\(id)/context")
            guard client.projectID == id, captured == generation else { return }
            revision = value["revision"].number.map(Int.init); loadedProject = id
            brief = value["brief"].string ?? ""; memory = value["memory"].string ?? ""; handoff = value["handoff"].string ?? ""
            selectedEntry = memoryDocument.prefixRange.length > 0 ? -1 : memoryDocument.entries.first?.id ?? -1
        } catch {
            if client.projectID == id, captured == generation { failed = true; message = error.localizedDescription }
        }
        if captured == generation { busy = false }
    }

    private func save() async {
        guard !busy, let revision, ready else { return }
        busy = true; message = ""; failed = false
        let id = loadedProject, captured = generation
        do {
            let value = try await client.request("/projects/\(id)/context", body: ["brief": brief, "memory": memory, "handoff": handoff, "expectedRevision": revision], method: "PUT")
            if client.projectID == id, captured == generation { self.revision = value["revision"].number.map(Int.init); message = "Context saved." }
        } catch {
            if client.projectID == id, captured == generation { failed = true; message = "\(error.localizedDescription) Your draft is still here. Reload latest to replace it before retrying." }
        }
        if captured == generation { busy = false }
    }
}
