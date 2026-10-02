import SwiftUI

struct WorkView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var selectedID: String?
    @State private var remoteSelectedID: String?
    @State private var showingRemote = false
    @State private var search = ""
    @State private var events: [JSON] = []
    @State private var result = ""
    @State private var shortened = false
    @State private var eventsShortened = false
    @State private var detailError = ""
    @State private var changing = false
    @State private var newTask = false
    @State private var followUpSource: JSON = .null
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
                Picker("Computer", selection: $showingRemote) {
                    Text("This Mac").tag(false); Text("Connected Macs").tag(true)
                }.pickerStyle(.segmented).frame(width: 250)
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await client.refresh() } }
                Button("New task", systemImage: "plus") { followUpSource = .null; newTask = true }
                    .disabled(!client.connected || client.projectID.isEmpty).keyboardShortcut("n")
            }.padding(20)
            if showingRemote {
                NativeRemoteWorkView(client: client, selected: $remoteSelectedID)
            } else { HSplitView {
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
                            if let model = selected["routing"]["selected"]["model"].string {
                                Text("Routed model: \(model) · \(selected["routing"]["selected"]["basis"].string ?? "Unknown basis")").font(.caption)
                                DisclosureGroup("Routing evidence") { Text(selected["routing"].prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
                            }
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
                            if selected["state"].string == "completed" {
                                Button(selected["followUp"]["kind"].string == "review" ? "Fix findings" : "Review work", systemImage: "arrow.triangle.branch") {
                                    followUpSource = selected; newTask = true
                                }.disabled(changing || !client.connected)
                            }
                            Text("Git change handoff is still available through the browser support dashboard.").font(.caption).foregroundStyle(.secondary)
                        } else {
                            ContentUnavailableView("Select a task", systemImage: "list.bullet.rectangle", description: Text("Read native results and review concrete permission requests."))
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(24)
                }.frame(minWidth: 320)
            } }
        }
        .sheet(isPresented: $newTask) { NativeTaskSheet(client: client, selectedID: $selectedID, remoteSelectedID: $remoteSelectedID, showingRemote: $showingRemote, source: followUpSource) }
        .confirmationDialog("Allow this exact native request once?", isPresented: Binding(get: { reviewedApproval != nil }, set: { if !$0 { reviewedApproval = nil } }), titleVisibility: .visible) {
            if let approval = reviewedApproval {
                Button("Allow once") { reviewedApproval = nil; Task { await answer(approval, decision: "accept") } }
            }
            Button("Cancel", role: .cancel) { reviewedApproval = nil }
        } message: { Text("Only the concrete request shown in the task detail is approved. No future requests are approved.") }
        .onChange(of: client.projectID) { _, _ in selectedID = nil; remoteSelectedID = nil; reviewedApproval = nil }
        .onChange(of: showingRemote) { _, _ in reviewedApproval = nil }
        .task(id: showingRemote ? nil : selectedID) {
            events = []; result = ""; detailError = ""; eventsShortened = false
            guard !showingRemote, let id = selectedID else { return }
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
    @Binding var remoteSelectedID: String?
    @Binding var showingRemote: Bool
    let source: JSON
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""
    @State private var harness = ""
    @State private var model = ""
    @State private var roleID = ""
    @State private var readOnly = true
    @State private var includeContext = true
    @State private var workspace = "worktree"
    @State private var deviceScope = "local"
    @State private var automaticRouting = true
    @State private var complexity = "standard"
    @State private var taskType = "coding"
    @State private var requiresImages = false
    @State private var webSearch = false
    @State private var imageGeneration = false
    @State private var key = UUID().uuidString
    @State private var starting = false
    @State private var suggesting = false
    @State private var error = ""
    @State private var advice: JSON = .null
    private var workers: [JSON] { client.harnesses.filter { $0["available"].bool == true && $0["workerSupported"].bool == true } }
    private var roles: [JSON] { client.project["roles"].array ?? [] }
    private var effectiveHarness: String { roles.first { $0["id"].string == roleID }?["harness"].string ?? harness }
    private var supportedReview: Bool { effectiveHarness.isEmpty || ["codex", "claude"].contains(effectiveHarness) }
    private var followUpKind: String { source["followUp"]["kind"].string == "review" ? "fix" : "review" }
    private var tools: [String] { (webSearch ? ["web_search"] : []) + (imageGeneration ? ["image_generation"] : []) }
    private var draft: String { [client.projectID, prompt, harness, model, roleID, String(readOnly), String(includeContext), workspace, deviceScope, String(automaticRouting), complexity, taskType, String(requiresImages), tools.joined(separator: ",")].joined(separator: "\u{0}") }
    private var routing: [String: Any] { ["complexity": complexity, "taskType": taskType, "requiresImages": requiresImages, "requiresTools": tools, "deviceScope": deviceScope] }
    private var pins: [String: Any] {
        var value: [String: Any] = [:]
        if !effectiveHarness.isEmpty { value["harness"] = effectiveHarness }
        if !roleID.isEmpty { value["roleId"] = roleID }
        let pin = model.trimmingCharacters(in: .whitespacesAndNewlines)
        if !pin.isEmpty { value["model"] = pin }
        if let id = source["id"].string { value["followUp"] = ["runId": id, "kind": followUpKind] }
        return value
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(source["id"].string == nil ? "Start a native worker" : followUpKind == "review" ? "Review linked work" : "Fix linked findings").font(.title2.weight(.semibold))
            ScrollView {
                Form {
                    Text("Project: \(client.project["name"].string ?? "Choose a project")")
                    TextEditor(text: $prompt).font(.body).frame(height: 95).accessibilityLabel("Task prompt")
                    Picker("Role", selection: $roleID) {
                        Text("No saved role").tag("")
                        ForEach(roles, id: \.selfID) { role in
                            Text("\(role["name"].string ?? "Role")\(role["peerId"].string == nil ? "" : " · remote")").tag(role["id"].string ?? "")
                        }
                    }
                    Picker("Harness", selection: $harness) {
                        Text(deviceScope == "connected" ? "Automatic (connected workers)" : "Automatic (local workers)").tag("")
                        ForEach(workers, id: \.selfID) { worker in Text(worker["name"].string ?? "Harness").tag(worker["id"].string ?? "") }
                    }.disabled(!roleID.isEmpty)
                    if let role = roles.first(where: { $0["id"].string == roleID }) {
                        Text(role["model"].string.map { "Saved model pin: \($0)" } ?? "Saved role uses its native default unless explicitly pinned.").font(.caption)
                    }
                    TextField("Model (optional explicit pin)", text: $model)
                    Toggle("Use routing policy", isOn: $automaticRouting)
                    Picker("Computers for automatic choice", selection: $deviceScope) {
                        Text("This Mac").tag("local"); Text("This Mac and connected Macs").tag("connected")
                    }.disabled(!roleID.isEmpty || source["id"].string != nil || workspace != "worktree" || !automaticRouting)
                    Text("Remote roles keep their saved owner. Automatic remote work requires a separate worktree and a tested project mapping.").font(.caption).foregroundStyle(.secondary)
                    Text(automaticRouting ? "Pins are preserved. Native model access, allowance and requirements are checked again on Start." : "Use your explicit pins or the native default. Required tools still need verified support.").font(.caption).foregroundStyle(.secondary)
                    Picker("Task type", selection: $taskType) {
                        Text("Coding").tag("coding"); Text("Reasoning").tag("reasoning"); Text("Data analysis").tag("data-analysis"); Text("Language").tag("language")
                    }
                    Picker("Complexity", selection: $complexity) { Text("Routine").tag("routine"); Text("Standard").tag("standard"); Text("Hard").tag("hard") }
                    Text("Saved preference: \(client.project["preference"].string ?? "Unknown"). Policy favors efficient workers for routine work. Dollar cost is unknown.").font(.caption).foregroundStyle(.secondary)
                    Toggle("Image input required", isOn: $requiresImages)
                    Toggle("Web search required", isOn: $webSearch)
                    Toggle("Image generation required", isOn: $imageGeneration)
                    Text("Required tools need fresh effective worker evidence. Unknown support blocks Start. Model vision and installed plugins do not prove tool access.").font(.caption).foregroundStyle(.secondary)
                    if source["id"].string == nil {
                        Picker("Workspace", selection: $workspace) { Text("Isolated worktree").tag("worktree"); Text("Project folder").tag("project") }
                    } else { Text("The linked work's original workspace is preserved.").font(.caption) }
                    Toggle("Use saved project context", isOn: $includeContext)
                    Toggle("Read only", isOn: $readOnly).disabled(source["id"].string != nil && followUpKind == "review")
                    if readOnly && !supportedReview { Text("Choose Codex or Claude for enforced read-only work.").foregroundStyle(.secondary) }
                    adviceDetails
                }.formStyle(.grouped)
            }
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.disabled(starting)
                Button("Suggest a model") { Task { await suggest() } }.disabled(starting || suggesting || !client.connected)
                if suggesting { ProgressView().controlSize(.small) }
                Spacer()
                Button("Start worker") { Task { await start() } }.keyboardShortcut(.defaultAction)
                    .disabled(starting || suggesting || !client.connected || client.projectID.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (readOnly && !supportedReview))
            }
        }.padding(24).frame(width: 620, height: 720).disabled(starting)
        .onChange(of: draft) { _, _ in key = UUID().uuidString; advice = .null }
        .onChange(of: workspace) { _, next in if next != "worktree" { deviceScope = "local" } }
        .onChange(of: roleID) { _, id in if let role = roles.first(where: { $0["id"].string == id }) { harness = role["harness"].string ?? "" } }
        .onAppear {
            guard source["id"].string != nil else { return }
            prompt = followUpKind == "review" ? "Review the linked work. Check the changes and report concrete findings with file paths and lines." : "Fix the findings in the linked review. Check the result and explain what changed."
            readOnly = followUpKind == "review"; harness = source["harness"].string ?? ""
            requiresImages = source["routing"]["requiresImages"].bool ?? false
            let inherited = source["routing"]["requiresTools"].array ?? []
            webSearch = inherited.contains(.string("web_search")); imageGeneration = inherited.contains(.string("image_generation"))
        }
    }
    @ViewBuilder private var adviceDetails: some View {
        if advice != .null {
            let choice = advice["choice"]
            Text(choice["model"].string.map { "\(choice["harness"].string ?? "Harness") · \($0)" } ?? "No suitable worker found").font(.headline)
            Text("Checked again on Start. Account allowance, model pins and required tools are checked by the service.").font(.caption)
            ForEach(Array(((advice["reasons"].array ?? []) + (advice["warnings"].array ?? []) + (choice["reasons"].array ?? []) + (choice["warnings"].array ?? [])).enumerated()), id: \.offset) { _, item in Text(item.string ?? "").font(.caption).foregroundStyle(.secondary) }
            if let score = choice["benchmark"]["score"].number {
                Text("LiveBench \(choice["benchmark"]["metric"].string ?? "Reference"): \(score.formatted())/100 · max effort · \(advice["benchmarkMethod"].string ?? "reference only")").font(.caption)
            }
        }
    }
    private func suggest() async {
        guard !suggesting else { return }; suggesting = true; error = ""
        let current = draft
        var body = routing.merging(pins) { _, pin in pin }; body["readOnly"] = readOnly
        body["workspace"] = source["workspaceKind"].string ?? workspace
        do {
            let value = try await client.request("/projects/\(client.projectID)/recommend", body: body)
            if draft == current { advice = value }
        } catch { if draft == current { self.error = error.localizedDescription } }
        suggesting = false
    }
    private func start() async {
        guard !starting else { return }; starting = true; error = ""
        let project = client.projectID
        var body = pins
        body.merge(["projectId": project, "prompt": prompt, "idempotencyKey": key, "readOnly": readOnly, "includeProjectContext": includeContext]) { _, next in next }
        if automaticRouting || requiresImages || !tools.isEmpty { body["routing"] = routing }
        if source["id"].string == nil { body["workspace"] = workspace }
        do {
            let run = try await client.request("/tasks/start", body: body)
            if client.projectID == project {
                if run["peerId"].string != nil {
                    remoteSelectedID = run["id"].string; showingRemote = true
                } else { selectedID = run["id"].string; showingRemote = false }
            }
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
