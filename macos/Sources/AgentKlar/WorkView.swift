import SwiftUI

struct WorkView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var selectedID: String?
    @State private var search = ""
    @State private var events: [JSON] = []
    @State private var result = ""
    @State private var shortened = false
    @State private var eventsShortened = false
    @State private var detailError = ""
    @State private var changing = false
    @State private var newTask = false
    @State private var reviewedApproval: JSON?
    private var runs: [JSON] {
        client.runs.filter { ($0["projectId"].string == client.projectID) && (search.isEmpty || ($0["prompt"].string ?? "").localizedCaseInsensitiveContains(search)) }
    }
    private var selected: JSON { client.runs.first { $0["id"].string == selectedID } ?? .null }
    private var approvals: [JSON] {
        (client.snapshot["approvals"].array ?? []).filter { $0["runId"].string == selectedID }
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Work").font(.largeTitle.weight(.semibold))
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await client.refresh() } }
                Button("New task", systemImage: "plus") { newTask = true }
                    .disabled(!client.connected || client.projectID.isEmpty).keyboardShortcut("n")
            }.padding(20)
            HSplitView {
                VStack {
                    TextField("Search tasks", text: $search).textFieldStyle(.roundedBorder).padding([.horizontal, .top], 12)
                    List(selection: $selectedID) {
                        ForEach(runs, id: \.selfID) { run in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(run["prompt"].string ?? "Task").lineLimit(2)
                                Text("\(run["state"].string ?? "Unknown") · \(run["harness"].string ?? "Native worker")")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.padding(.vertical, 5).tag(run["id"].string ?? "")
                        }
                    }
                    if runs.isEmpty { Text("No tasks in this project.").foregroundStyle(.secondary).padding() }
                }.frame(minWidth: 240, idealWidth: 300, maxWidth: 400)
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if let id = selected["id"].string {
                            HStack {
                                Text(selected["state"].string ?? "Unknown").foregroundStyle(.secondary)
                                Spacer()
                                if ["running", "needs_attention"].contains(selected["state"].string ?? "") {
                                    Button("Stop task", role: .destructive) { Task { await act { _ = try await client.request("/runs/\(id)/stop", body: [:]) } } }
                                        .disabled(changing || !client.connected)
                                }
                            }
                            Text(selected["prompt"].string ?? "Task").font(.title2).textSelection(.enabled)
                            if selected["promptTruncated"].bool == true { Text("Task prompt preview shortened.").font(.caption).foregroundStyle(.secondary) }
                            Text(selected["tokens"].number.map { "Reported tokens: \(Int($0))" } ?? "Token usage unknown").font(.caption).foregroundStyle(.secondary)
                            Text("Completion means the worker finished. Human review is separate.").font(.caption).foregroundStyle(.secondary)
                            if let error = selected["error"].string, !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                            if !detailError.isEmpty { Text(detailError).foregroundStyle(.red) }
                            ForEach(approvals, id: \.selfID) { approval in
                                GroupBox("Native permission request") {
                                    VStack(alignment: .leading, spacing: 10) {
                                        Text(approval["title"].string ?? "Review this exact request").font(.headline)
                                        Text(approval["details"].prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                        HStack {
                                            if concrete(approval), (approval["decisions"].array ?? []).contains(where: { $0.string == "accept" }) {
                                                Button("Allow once…") { reviewedApproval = approval }
                                            }
                                            ForEach((approval["decisions"].array ?? []).compactMap(\.string).filter { ["decline", "cancel"].contains($0) }, id: \.self) { decision in
                                                Button(decision.capitalized) { Task { await answer(approval, decision: decision) } }
                                            }
                                        }.disabled(changing || !client.connected)
                                        if !concrete(approval) { Text("This request cannot be approved safely in this native view. You can decline or cancel it.").font(.caption).foregroundStyle(.secondary) }
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                                }
                            }
                            if !result.isEmpty {
                                Text("Result").font(.headline)
                                Text(result).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                                if shortened { Text("Result is shortened. Read more through your native MCP host.").font(.caption).foregroundStyle(.secondary) }
                            }
                            DisclosureGroup("Native events") {
                                ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(event["kind"].string ?? "Event").font(.caption).foregroundStyle(.secondary)
                                        Text(event["text"].string ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                        if event["textTruncated"].bool == true { Text("Event text shortened.").font(.caption).foregroundStyle(.secondary) }
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
                                }
                            }
                            if eventsShortened { Text("Event history is a bounded preview. Use your native MCP host for more.").font(.caption).foregroundStyle(.secondary) }
                            Text("Remote approvals, handoff and Git change review are not yet available in this native view.").font(.caption).foregroundStyle(.secondary)
                        } else {
                            ContentUnavailableView("Select a task", systemImage: "list.bullet.rectangle", description: Text("Read native results and review concrete permission requests."))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
                }.frame(minWidth: 320)
            }
        }
        .sheet(isPresented: $newTask) { NativeTaskSheet(client: client, selectedID: $selectedID) }
        .confirmationDialog("Allow this exact native request once?", isPresented: Binding(get: { reviewedApproval != nil }, set: { if !$0 { reviewedApproval = nil } }), titleVisibility: .visible) {
            if let approval = reviewedApproval {
                Button("Allow once") { reviewedApproval = nil; Task { await answer(approval, decision: "accept") } }
            }
            Button("Cancel", role: .cancel) { reviewedApproval = nil }
        } message: { Text("Only the concrete request shown in the task detail is approved. No future requests are approved.") }
        .onChange(of: client.projectID) { _, _ in selectedID = nil; reviewedApproval = nil }
        .task(id: selectedID) {
            events = []; result = ""; detailError = ""; eventsShortened = false
            guard let id = selectedID else { return }
            var after = 0
            while !Task.isCancelled {
                do {
                    let tail = try await client.request("/runs/\(id)/tail?after=\(after)")
                    let full = try await client.request("/runs/\(id)/result")
                    guard selectedID == id, !Task.isCancelled else { return }
                    let incoming = tail["events"].array ?? []
                    after = tail["nextAfter"].number.map(Int.init) ?? after
                    let combined = events + incoming
                    events = Array(combined.suffix(600))
                    eventsShortened = eventsShortened || tail["hasMore"].bool == true || combined.count > 600 || incoming.contains { $0["textTruncated"].bool == true }
                    result = full["result"].string ?? ""; shortened = full["resultTruncated"].bool == true
                } catch { if selectedID == id { detailError = error.localizedDescription }; return }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }
    private func concrete(_ approval: JSON) -> Bool {
        let details = approval["details"]
        if approval["kind"].string == "command" { return !(details["command"].string ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && details["cwd"].string != nil }
        guard approval["kind"].string == "file" else { return false }
        if let path = details["file_path"].string, path.hasPrefix("/") {
            if details["tool"].string == "Write" { return details["content"].string != nil }
            if details["tool"].string == "Edit" { return details["old_string"].string != nil && details["new_string"].string != nil }
        }
        let changes = details["changes"].array ?? []
        return !changes.isEmpty && changes.allSatisfy { $0["path"].string != nil && $0["diff"].string != nil }
    }
    private func answer(_ approval: JSON, decision: String) async {
        guard approval["runId"].string == selectedID, let id = approval["id"].string,
              approvals.contains(where: { $0["id"].string == id && $0.prettyText == approval.prettyText }), decision != "accept" || concrete(approval) else { return }
        await act { _ = try await client.request("/approvals/\(id)", body: ["decision": decision]) }
    }
    private func act(_ work: () async throws -> Void) async {
        guard !changing else { return }; changing = true; detailError = ""
        do { try await work(); await client.refresh() } catch { detailError = error.localizedDescription }
        changing = false
    }
}

private struct NativeTaskSheet: View {
    @ObservedObject var client: AgentKlarClient
    @Binding var selectedID: String?
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var harness = ""
    @State private var model = ""
    @State private var roleID = ""
    @State private var readOnly = true
    @State private var includeContext = true
    @State private var workspace = "worktree"
    @State private var key = UUID().uuidString
    @State private var starting = false
    @State private var error = ""
    private var workers: [JSON] { client.harnesses.filter { $0["available"].bool == true && $0["workerSupported"].bool == true } }
    private var roles: [JSON] { (client.project["roles"].array ?? []).filter { $0["peerId"].string == nil } }
    private var effectiveHarness: String { roles.first { $0["id"].string == roleID }?["harness"].string ?? harness }
    private var supportedReview: Bool { ["codex", "claude"].contains(effectiveHarness) }
    private var draft: String { [prompt, harness, model, roleID, String(readOnly), String(includeContext), workspace].joined(separator: "\u{0}") }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Start a native worker").font(.title2.weight(.semibold))
            Form {
                Text("Project: \(client.project["name"].string ?? "Choose a project")")
                TextEditor(text: $prompt).font(.body).frame(height: 110).accessibilityLabel("Task prompt")
                Picker("Role", selection: $roleID) {
                    Text("No saved role").tag("")
                    ForEach(roles, id: \.selfID) { Text($0["name"].string ?? "Role").tag($0["id"].string ?? "") }
                }
                Picker("Harness", selection: $harness) {
                    Text("Choose installed harness").tag("")
                    ForEach(workers, id: \.selfID) { worker in HStack { NativeHarnessIcon(harness: worker["id"].string ?? "", size: 18); Text(worker["name"].string ?? "Harness") }.tag(worker["id"].string ?? "") }
                }.disabled(!roleID.isEmpty)
                if let savedRole = roles.first(where: { $0["id"].string == roleID }) {
                    Text(savedRole["model"].string.map { "Saved role model: \($0). A model entered below is an explicit override." } ?? "This role uses its harness's native model default unless you enter an explicit pin below.").font(.caption).foregroundStyle(.secondary)
                }
                TextField("Model (optional native pin)", text: $model)
                Picker("Workspace", selection: $workspace) { Text("Isolated worktree").tag("worktree"); Text("Project folder").tag("project") }
                Toggle("Use saved project context", isOn: $includeContext)
                Toggle("Read only", isOn: $readOnly)
                if readOnly && !supportedReview { Text("Choose Codex or Claude Code for read-only work, or turn off Read only for a regular native task.").foregroundStyle(.secondary) }
                Text("Your native account and permission settings apply. Model choice is explicit here; automatic benchmark routing is not included.").font(.caption).foregroundStyle(.secondary)
            }.formStyle(.grouped)
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.disabled(starting)
                Spacer()
                Button("Start worker") { Task { await start() } }.keyboardShortcut(.defaultAction)
                    .disabled(starting || !client.connected || client.projectID.isEmpty || effectiveHarness.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (readOnly && !supportedReview))
            }
        }.padding(24).frame(width: 550).disabled(starting)
        .onChange(of: draft) { _, _ in key = UUID().uuidString }
        .onChange(of: roleID) { _, id in
            if let role = roles.first(where: { $0["id"].string == id }) { harness = role["harness"].string ?? "" }
        }
    }
    private func start() async {
        guard !starting else { return }; starting = true; error = ""
        let projectID = client.projectID
        var body: [String: Any] = ["projectId": projectID, "prompt": prompt, "harness": effectiveHarness, "idempotencyKey": key, "readOnly": readOnly, "includeProjectContext": includeContext, "workspace": workspace]
        if !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["model"] = model.trimmingCharacters(in: .whitespacesAndNewlines) }
        if !roleID.isEmpty { body["roleId"] = roleID }
        do {
            let run = try await client.request("/tasks/start", body: body)
            if client.projectID == projectID { selectedID = run["id"].string }
            await client.refresh(); dismiss()
        } catch { self.error = error.localizedDescription }
        starting = false
    }
}

extension JSON {
    var selfID: String { self["id"].string ?? self["harness"].string ?? "unknown" }
    var prettyText: String {
        guard JSONSerialization.isValidJSONObject(any), let data = try? JSONSerialization.data(withJSONObject: any, options: [.prettyPrinted, .sortedKeys]), let value = String(data: data, encoding: .utf8) else { return string ?? "No concrete details." }
        return value
    }
}
