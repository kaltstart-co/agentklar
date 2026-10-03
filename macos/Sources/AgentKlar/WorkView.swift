import SwiftUI

struct WorkView: View {
    @ObservedObject var client: AgentKlarClient
    var active = true
    @State private var selectedID: String?
    @State private var selectedActivityID: String?
    @State private var selectedSessionID: String?
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
    private var activities: [JSON] {
        (client.snapshot["activities"].array ?? []).filter {
            $0["projectId"].string == client.projectID && (search.isEmpty || ($0["title"].string ?? "").localizedCaseInsensitiveContains(search) || ($0["summary"].string ?? "").localizedCaseInsensitiveContains(search))
        }
    }
    private var selectedActivity: JSON {
        activities.first { $0["activityId"].string == selectedActivityID } ?? .null
    }
    private var observedSessions: [JSON] {
        (client.snapshot["observedSessions"].array ?? []).filter { $0["projectId"].string == client.projectID && (search.isEmpty || "Claude Code session".localizedCaseInsensitiveContains(search)) }
    }
    private var selectedSession: JSON { observedSessions.first { $0["id"].string == selectedSessionID } ?? .null }
    private var approvals: [JSON] {
        (client.snapshot["approvals"].array ?? []).filter { $0["runId"].string == selectedID }
    }
    private var pollingID: String { active && !showingRemote ? selectedID ?? "" : "" }
    var body: some View {
        VStack(spacing: 0) {
            NativePageHeader(title: "Work") {
                Button { Task { await client.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).disabled(!client.connected)
                    .help("Refresh work").accessibilityLabel("Refresh work")
                Button("New task", systemImage: "plus") { followUpSource = .null; newTask = true }
                    .buttonStyle(.borderedProminent).disabled(!client.connected || client.projectID.isEmpty)
                    .keyboardShortcut(active ? KeyboardShortcut("n", modifiers: .command) : nil).help("Create a task")
            }.padding(.horizontal, NativeStyle.pagePadding).padding(.top, NativeStyle.pagePadding).padding(.bottom, 20)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 20) { workFilters }
                VStack(alignment: .leading, spacing: 12) { workFilters }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, NativeStyle.pagePadding).padding(.bottom, 16)
            if !runs.isEmpty || !activities.isEmpty || !observedSessions.isEmpty || showingRemote { Divider() }
            if showingRemote {
                NativeRemoteWorkView(client: client, selected: $remoteSelectedID) { source in followUpSource = source; newTask = true }
            } else if runs.isEmpty && activities.isEmpty && observedSessions.isEmpty && search.isEmpty {
                emptyWork
            } else { NativeWorkLayout {
                VStack {
                    List(selection: $selectedID) {
                        if !observedSessions.isEmpty {
                            Section("Native sessions") {
                                ForEach(observedSessions, id: \.selfID) { session in
                                    Button { selectedID = nil; selectedActivityID = nil; selectedSessionID = session["id"].string } label: {
                                        HStack(spacing: 10) {
                                            NativeHarnessIcon(harness: "claude", size: 24)
                                            VStack(alignment: .leading, spacing: 5) {
                                                Text("Claude Code session").lineLimit(1)
                                                Text(NativeObservedSessionDetail.stateLabel(session))
                                                    .font(NativeStyle.caption).foregroundStyle(.secondary)
                                            }
                                            Spacer(minLength: 0)
                                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6).contentShape(Rectangle())
                                    }.buttonStyle(.plain)
                                        .listRowBackground(selectedSessionID == session["id"].string ? Color.accentColor.opacity(0.12) : .clear)
                                }
                            }
                        }
                        if !activities.isEmpty {
                            Section("Reported by your harness") {
                                ForEach(activities, id: \.selfID) { activity in
                                    Button { selectedID = nil; selectedSessionID = nil; selectedActivityID = activity["activityId"].string } label: {
                                        HStack(alignment: .top, spacing: 10) {
                                            Image(systemName: "text.bubble").frame(width: 24)
                                            VStack(alignment: .leading, spacing: 5) {
                                                Text(activity["title"].string ?? "Task").lineLimit(2)
                                                Text("\(activity["source"]["clientName"].string ?? "Harness") · \(activity["state"].string ?? "Unknown")")
                                                    .font(NativeStyle.caption).foregroundStyle(.secondary)
                                            }
                                            Spacer(minLength: 0)
                                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6).contentShape(Rectangle())
                                    }.buttonStyle(.plain)
                                        .listRowBackground(selectedActivityID == activity["activityId"].string ? Color.accentColor.opacity(0.12) : .clear)
                                }
                            }
                        }
                        Section("AgentKlar workers") {
                        ForEach(runs, id: \.selfID) { run in
                            HStack(alignment: .top, spacing: 10) {
                                NativeHarnessIcon(harness: run["harness"].string ?? "", size: 24)
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(run["prompt"].string ?? "Task").lineLimit(2)
                                    Text("\(stateName(run["state"].string)) · \(run["harness"].string ?? "Native worker")")
                                        .font(NativeStyle.caption).foregroundStyle(.secondary)
                                }
                            }.padding(.vertical, 6).tag(run["id"].string ?? "")
                        }
                        }
                    }
                    if runs.isEmpty && activities.isEmpty && observedSessions.isEmpty { Text("No matching tasks.").foregroundStyle(.secondary).padding() }
                }
            } detail: {
                if selectedSession != .null {
                    NativeObservedSessionDetail(client: client, session: selectedSession)
                } else if selectedActivity != .null {
                    NativeReportedWorkDetail(activity: selectedActivity)
                } else if selected["id"].string == nil {
                    NativeEmptyState("Select a task", systemImage: "list.bullet.rectangle", description: "Read its result, follow progress and review permission requests.") {}
                } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if let id = selected["id"].string {
                            HStack {
                                Label(stateName(selected["state"].string), systemImage: selected["state"].string == "completed" ? "checkmark.circle" : "circle.dotted").font(NativeStyle.caption).foregroundStyle(.secondary)
                                Spacer()
                                if ["running", "needs_attention"].contains(selected["state"].string ?? "") {
                                    Button("Stop task", role: .destructive) { Task { await act { _ = try await client.request("/runs/\(id)/stop", body: [:]) } } }
                                        .disabled(changing || !client.connected)
                                }
                            }
                            Text(NativeTaskTitle.text(selected["prompt"].string)).font(NativeStyle.title).lineLimit(2).textSelection(.enabled)
                            if selected["promptTruncated"].bool == true { Text("Task prompt preview shortened.").font(NativeStyle.caption).foregroundStyle(.secondary) }
                            HStack(spacing: 8) {
                                NativeHarnessIcon(harness: selected["harness"].string ?? "", size: 18)
                                Text(selected["harness"].string ?? "Native worker")
                                Text("·")
                                Text(selected["tokens"].number.map { "\($0.formatted(.number.precision(.fractionLength(0)))) reported tokens" } ?? "Usage not reported")
                            }.font(NativeStyle.caption).foregroundStyle(.secondary)
                            if let model = selected["routing"]["selected"]["model"].string {
                                Text(model).font(NativeStyle.caption).foregroundStyle(.secondary)
                            }
                            if selected["state"].string == "completed" { Text("Worker finished. Ready for review.").font(NativeStyle.caption).foregroundStyle(.secondary) }
                            NativeDetailButton("Task instructions") {
                                Text(selected["prompt"].string ?? "Task").font(NativeStyle.document).lineSpacing(4).textSelection(.enabled)
                            }.id("prompt:" + id)
                            if let error = selected["error"].string, !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                            if !detailError.isEmpty { Text(detailError).foregroundStyle(.red) }
                            ForEach(approvals, id: \.selfID) { approval in
                                GroupBox("Native permission request") {
                                    VStack(alignment: .leading, spacing: 10) {
                                        Text(approval["title"].string ?? "Review this exact request").font(NativeStyle.heading)
                                        Text(approval["details"].prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                        HStack {
                                            if concrete(approval), (approval["decisions"].array ?? []).contains(where: { $0.string == "accept" }) {
                                                Button("Allow once…") { reviewedApproval = approval }
                                            }
                                            ForEach((approval["decisions"].array ?? []).compactMap(\.string).filter { ["decline", "cancel"].contains($0) }, id: \.self) { decision in
                                                Button(decision.capitalized) { Task { await answer(approval, decision: decision) } }
                                            }
                                        }.disabled(changing || !client.connected)
                                        if !concrete(approval) { Text("This request cannot be approved safely in this native view. You can decline or cancel it.").font(NativeStyle.caption).foregroundStyle(.secondary) }
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(4)
                                }
                            }
                            if !result.isEmpty {
                                VStack(alignment: .leading, spacing: 12) {
                                    Divider()
                                    Text("Result").font(NativeStyle.heading)
                                    VStack(alignment: .leading, spacing: 12) {
                                        Text(result).font(NativeStyle.document).lineSpacing(4).textSelection(.enabled)
                                        if shortened { Text("Result is shortened. Read more through your native MCP host.").font(NativeStyle.caption).foregroundStyle(.secondary) }
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
                                }
                            }
                            if selected["routing"] != .null {
                                NativeDetailButton("Model choice details") { Text(selected["routing"].prettyText).font(.system(size: 13, design: .monospaced)).textSelection(.enabled) }.id("routing:" + id)
                            }
                            NativeDetailButton("Native events") {
                                if events.isEmpty { Text("No native events reported yet.").foregroundStyle(.secondary) }
                                if eventsShortened { Text("Event history is a bounded preview. Use your native MCP host for more.").font(NativeStyle.caption).foregroundStyle(.secondary) }
                                ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(event["kind"].string ?? "Event").font(NativeStyle.caption).foregroundStyle(.secondary)
                                        Text(event["text"].string ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                                        if event["textTruncated"].bool == true { Text("Event text shortened.").font(NativeStyle.caption).foregroundStyle(.secondary) }
                                    }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
                                }
                            }.id("events:" + id)
                            if eventsShortened { Text("Event history is a bounded preview. Use your native MCP host for more.").font(NativeStyle.caption).foregroundStyle(.secondary) }
                            if selected["state"].string == "completed" {
                                Button(selected["followUp"]["kind"].string == "review" ? "Fix findings" : "Review work", systemImage: "arrow.triangle.branch") {
                                    followUpSource = selected; newTask = true
                                }.disabled(changing || !client.connected)
                            }
                            NativeDetailButton("Move changes to another project") { NativeChangesView(client: client, sourceID: id).id(id) }.id("changes:" + id)
                        }
                    }.frame(maxWidth: 760, alignment: .leading).padding(NativeStyle.pagePadding).frame(maxWidth: .infinity)
                }
                }
            } }
        }
        .font(NativeStyle.body).controlSize(.regular)
        .labelStyle(.titleAndIcon)
        .sheet(isPresented: $newTask) { NativeTaskSheet(client: client, selectedID: $selectedID, remoteSelectedID: $remoteSelectedID, showingRemote: $showingRemote, source: followUpSource) }
        .confirmationDialog("Allow this exact native request once?", isPresented: Binding(get: { reviewedApproval != nil }, set: { if !$0 { reviewedApproval = nil } }), titleVisibility: .visible) {
            if let approval = reviewedApproval {
                Button("Allow once") { reviewedApproval = nil; Task { await answer(approval, decision: "accept") } }
            }
            Button("Cancel", role: .cancel) { reviewedApproval = nil }
        } message: { Text("Only the concrete request shown in the task detail is approved. No future requests are approved.") }
        .onChange(of: client.projectID) { _, _ in selectedID = nil; selectedActivityID = nil; selectedSessionID = nil; remoteSelectedID = nil; reviewedApproval = nil }
        .onChange(of: selectedID) { _, id in if id != nil { selectedActivityID = nil; selectedSessionID = nil } }
        .onChange(of: showingRemote) { _, _ in reviewedApproval = nil }
        .task(id: client.requestedRunID) {
            guard let id = client.requestedRunID else { return }
            await client.refresh()
            guard client.requestedRunID == id, !Task.isCancelled else { return }
            if client.runs.contains(where: { $0["id"].string == id }) {
                selectedID = id; showingRemote = false
            } else if (client.snapshot["remoteDispatches"].array ?? []).contains(where: { $0["id"].string == id && $0["projectId"].string == client.projectID }) {
                remoteSelectedID = id; showingRemote = true
            } else { client.reportError("This task is no longer available in the selected project. Refresh its saved handoff or choose another task.") }
            client.requestedRunID = nil
        }
        .task(id: pollingID) {
            guard active, !showingRemote, let id = selectedID else { return }
            events = []; result = ""; detailError = ""; eventsShortened = false
            var after = 0
            while !Task.isCancelled {
                do {
                    let tail = try await client.request("/runs/\(id)/tail?after=\(after)")
                    let full = try await client.request("/runs/\(id)/result")
                    guard active, selectedID == id, !Task.isCancelled else { return }
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
    @ViewBuilder private var workFilters: some View {
        NativePageTabs(selection: Binding(get: { showingRemote ? "Connected Macs" : "This Mac" }, set: { showingRemote = $0 == "Connected Macs" }), items: ["This Mac", "Connected Macs"])
            .frame(width: 250).accessibilityLabel("Computer for task list")
        if !showingRemote {
            NativeSearchField(placeholder: "Search tasks", text: $search).frame(minWidth: 140, maxWidth: 300)
        }
    }
    @ViewBuilder private var emptyWork: some View {
        NativeEmptyState("Start work with your agents", systemImage: "square.stack.3d.up", description: "Start a task here, or ask a connected harness to track its work in AgentKlar.") {
                Button("New task", systemImage: "plus") { followUpSource = .null; newTask = true }
                    .buttonStyle(.borderedProminent).controlSize(.regular).disabled(!client.connected)
        }
    }
    private func stateName(_ value: String?) -> String {
        ["running": "Working", "needs_attention": "Needs attention", "completed": "Finished", "failed": "Failed", "cancelled": "Cancelled", "interrupted": "Interrupted"][value ?? ""] ?? "Unknown"
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

enum NativeTaskTitle {
    static func text(_ prompt: String?) -> String {
        let firstLine = (prompt ?? "Task").split(whereSeparator: \.isNewline).first.map(String.init) ?? "Task"
        return firstLine.count > 90 ? String(firstLine.prefix(90)) + "…" : firstLine
    }
}

// Keep the task list useful when a small window cannot fit two readable columns.
struct NativeWorkLayout<ListContent: View, DetailContent: View>: View {
    let list: ListContent
    let detail: DetailContent
    init(@ViewBuilder list: () -> ListContent, @ViewBuilder detail: () -> DetailContent) {
        self.list = list(); self.detail = detail()
    }
    var body: some View {
        GeometryReader { space in
            if space.size.width >= 600 {
                HSplitView {
                    list.frame(minWidth: 220, idealWidth: 280, maxWidth: 340)
                    detail.frame(minWidth: 280)
                }
            } else {
                VStack(spacing: 0) {
                    list.frame(height: min(220, space.size.height * 0.36))
                    Divider()
                    detail.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
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
    @State private var optionsTab = "Assignment"
    @State private var key = UUID().uuidString
    @State private var starting = false
    @State private var suggesting = false
    @State private var error = ""
    @State private var advice: JSON = .null
    private var workers: [JSON] { client.harnesses.filter { $0["available"].bool == true && $0["workerSupported"].bool == true } }
    private var roles: [JSON] {
        let all = client.project["roles"].array ?? []
        guard source["id"].string != nil else { return all }
        return all.filter { $0["peerId"] == source["peerId"] }
    }
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
            Text(source["id"].string == nil ? "New task" : followUpKind == "review" ? "Review linked work" : "Fix linked findings").font(NativeStyle.title)
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 12) {
                    NativeSectionTitle(title: "Task")
                    Text(client.project["name"].string ?? "Choose a project").font(NativeStyle.caption).foregroundStyle(.secondary)
                    TextEditor(text: $prompt).font(NativeStyle.body).scrollContentBackground(.hidden).padding(12).frame(height: 160)
                        .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .topLeading) {
                            if prompt.isEmpty {
                                Text("Describe the work you want this agent to do…")
                                    .font(NativeStyle.body).foregroundStyle(.tertiary).padding(16)
                                    .allowsHitTesting(false).accessibilityHidden(true)
                            }
                        }
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.quaternary, lineWidth: 1))
                        .accessibilityLabel("Task prompt")
                }
                NativePageTabs(selection: $optionsTab, items: ["Assignment", "Routing", "Tools", "Workspace"])
                if optionsTab == "Assignment" {
                VStack(alignment: .leading, spacing: 12) {
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
                        Text(role["model"].string.map { "Saved model pin: \($0)" } ?? "Saved role uses its native default unless explicitly pinned.").font(NativeStyle.caption)
                    }
                    TextField("Model (optional)", text: $model).textFieldStyle(.roundedBorder)
                }
                }
                if optionsTab == "Routing" {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Use routing policy", isOn: $automaticRouting)
                    Picker("Computers for automatic choice", selection: $deviceScope) {
                        Text("This Mac").tag("local"); Text("This Mac and connected Macs").tag("connected")
                    }.disabled(!roleID.isEmpty || source["id"].string != nil || workspace != "worktree" || !automaticRouting)
                    Picker("Task type", selection: $taskType) {
                        Text("Coding").tag("coding"); Text("Reasoning").tag("reasoning"); Text("Data analysis").tag("data-analysis"); Text("Language").tag("language")
                    }
                    Picker("Complexity", selection: $complexity) { Text("Routine").tag("routine"); Text("Standard").tag("standard"); Text("Hard").tag("hard") }
                    Text("Preference: \(client.project["preference"].string ?? "Unknown")").font(NativeStyle.caption).foregroundStyle(.secondary)
                    NativeDetailButton("How routing works") {
                        Text("Remote roles keep their saved owner. Automatic remote work requires a separate worktree and a tested project mapping.")
                        Text(automaticRouting ? "Pins are preserved. Native model access, allowance and requirements are checked again on Start." : "Use your explicit pins or the native default. Required tools still need verified support.")
                        Text("Efficient workers are favored for routine work. Dollar cost is unknown.")
                    }.font(NativeStyle.caption).foregroundStyle(.secondary)
                }
                }
                if optionsTab == "Tools" {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle("Image input required", isOn: $requiresImages)
                    Toggle("Web search required", isOn: $webSearch)
                    Toggle("Image generation required", isOn: $imageGeneration)
                    Text("Choose the tools this task needs. AgentKlar checks worker support before starting.").font(NativeStyle.caption).foregroundStyle(.secondary)
                }
                }
                if optionsTab == "Workspace" {
                VStack(alignment: .leading, spacing: 12) {
                    if source["id"].string == nil {
                        Picker("Workspace", selection: $workspace) { Text("Isolated worktree").tag("worktree"); Text("Project folder").tag("project") }
                    } else { Text("The linked work's original workspace is preserved.").font(NativeStyle.caption) }
                    Toggle("Use saved project context", isOn: $includeContext)
                    Toggle("Read only", isOn: $readOnly).disabled(source["id"].string != nil && followUpKind == "review")
                    if readOnly && !supportedReview { Text("Choose Codex or Claude for enforced read-only work.").foregroundStyle(.secondary) }
                }
                }
                    adviceDetails
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
            }.frame(maxHeight: .infinity)
            if !error.isEmpty { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            Text((readOnly ? "Read only" : "Changes allowed") + " · " + (source["id"].string != nil ? "Linked workspace" : workspace == "worktree" ? "Isolated worktree" : "Project folder"))
                .font(NativeStyle.caption).foregroundStyle(.secondary)
            HStack {
                Button("Cancel", role: .cancel) { dismiss() }.disabled(starting)
                Button("Suggest a model") { Task { await suggest() } }.disabled(starting || suggesting || !client.connected)
                if suggesting { ProgressView().controlSize(.small) }
                Spacer()
                Button("Start worker") { Task { await start() } }.keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
                    .disabled(starting || suggesting || !client.connected || client.projectID.isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (readOnly && !supportedReview))
            }
        }.font(NativeStyle.body).controlSize(.regular).buttonStyle(.bordered)
            .padding(NativeStyle.pagePadding).frame(minWidth: 500, idealWidth: 620, maxWidth: 700, minHeight: 480, idealHeight: 700, maxHeight: 800).disabled(starting)
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
            if let model = choice["model"].string {
                Text("\(choice["harness"].string ?? "Harness") · \(model)").font(NativeStyle.heading)
            } else { Text("No suitable worker found").font(NativeStyle.heading) }
            Text("Checked again on Start. Account allowance, model pins and required tools are checked by the service.").font(NativeStyle.caption)
            ForEach(Array(adviceMessages.enumerated()), id: \.offset) { _, text in Text(text).font(NativeStyle.caption).foregroundStyle(.secondary) }
            if let score = choice["benchmark"]["score"].number {
                Text("LiveBench \(choice["benchmark"]["metric"].string ?? "Reference"): \(score.formatted())/100 · max effort · \(advice["benchmarkMethod"].string ?? "reference only")").font(NativeStyle.caption)
            }
        }
    }
    private var adviceMessages: [String] {
        var messages = advice["reasons"].array ?? []
        messages.append(contentsOf: advice["warnings"].array ?? [])
        messages.append(contentsOf: advice["choice"]["reasons"].array ?? [])
        messages.append(contentsOf: advice["choice"]["warnings"].array ?? [])
        return messages.compactMap(\.string)
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
        if automaticRouting || requiresImages || !tools.isEmpty || source["routing"]["requiresImages"].bool == true || !(source["routing"]["requiresTools"].array ?? []).isEmpty { body["routing"] = routing }
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
    var selfID: String { self["id"].string ?? self["activityId"].string ?? self["harness"].string ?? "unknown" }
    var prettyText: String {
        guard JSONSerialization.isValidJSONObject(any), let data = try? JSONSerialization.data(withJSONObject: any, options: [.prettyPrinted, .sortedKeys]), let value = String(data: data, encoding: .utf8) else { return string ?? "No concrete details." }
        return value
    }
}
