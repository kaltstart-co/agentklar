import SwiftUI
import AppKit

struct TeamView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var selectedRoleID: String?
    @State private var roles: [NativeRoleDraft] = []
    @State private var savedRoleCount = 0
    @State private var preset = NativeRoutingPreset.builtIns[1]
    @State private var savedPreset = NativeRoutingPreset.builtIns[1]
    @State private var presets = NativeRoutingPreset.builtIns
    @State private var delegationMode = "manual"
    @State private var savedDelegationMode = "manual"
    @State private var loadedProject = ""
    @State private var projectGeneration = UUID()
    @State private var saving = false
    @State private var message = ""
    @State private var failed = false
    @State private var presetEditor: NativeRoutingEditorSession?
    @State private var configuringPolicy = false
    private var workers: [JSON] { client.harnesses.filter { $0["available"].bool == true && $0["workerSupported"].bool == true } }
    private var peers: [JSON] { (client.snapshot["peers"].array ?? []).filter { $0["projectId"].string == client.projectID } }
    private let remoteHarnesses = ["codex", "claude", "muse", "opencode", "gemini", "cursor-agent", "zcode"]
    var body: some View {
        if client.projectID.isEmpty {
            ContentUnavailableView("Choose a project", systemImage: "person.2", description: Text("Create roles for the work you delegate often."))
        } else {
            VStack(alignment: .leading, spacing: 22) {
                NativePageHeader(title: "Team", subtitle: "Roles and responsibilities for this project.") { teamActions }
                if !message.isEmpty {
                    Text(message).font(NativeStyle.caption).foregroundStyle(failed ? .red : .secondary)
                        .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                }
                if roles.isEmpty {
                    NativeEmptyState("Build your team", systemImage: "person.2", description: "Add a role for work you delegate often.") {
                        Button("Add role", systemImage: "plus") { addRole() }
                            .buttonStyle(.borderedProminent).disabled((workers.isEmpty && peers.isEmpty) || roles.count >= 30)
                    }
                } else {
                    HStack(alignment: .top, spacing: 24) {
                        roster.frame(width: 200)
                        Divider()
                        selectedEditor.frame(maxWidth: .infinity, maxHeight: .infinity)
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                policySummary
            }
            .font(NativeStyle.body).frame(maxWidth: NativeStyle.contentWidth, maxHeight: .infinity, alignment: .topLeading)
            .padding(NativeStyle.pagePadding).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .disabled(saving || !client.connected)
            .task(id: client.projectID) {
                loadedProject = client.projectID
                projectGeneration = UUID()
                presetEditor = nil; configuringPolicy = false
                preset = NativeRoutingPreset.projectPreset(client.project)
                savedPreset = preset
                delegationMode = client.project["delegationMode"].string ?? "manual"
                savedDelegationMode = delegationMode
                presets = NativeRoutingPreset.builtIns
                roles = (client.project["roles"].array ?? []).map(NativeRoleDraft.init)
                savedRoleCount = roles.count
                selectedRoleID = roles.first?.id
                message = ""
                await loadPresets(projectID: loadedProject, generation: projectGeneration)
            }
            .sheet(isPresented: $configuringPolicy) { policyConfiguration }
        }
    }
    private var routingChanged: Bool { preset != savedPreset || delegationMode != savedDelegationMode }
    private var presetChoices: [NativeRoutingPreset] {
        var choices = presets.map { $0.id == preset.id ? preset : $0 }
        if !choices.contains(where: { $0.id == preset.id }) { choices.append(preset) }
        return choices
    }
    private var policySummary: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack(spacing: 12) {
                Image(systemName: "slider.horizontal.3").foregroundStyle(.secondary)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Routing and delegation").fontWeight(.medium)
                    Text(preset.name + " · " + (delegationMode == "manual" ? "Only when asked" : "Use team when helpful") + (routingChanged ? " · Not applied" : ""))
                        .font(NativeStyle.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 16)
                Button("Configure…") { message = ""; failed = false; configuringPolicy = true }
                    .buttonStyle(.plain).foregroundStyle(.tint).disabled(loadedProject != client.projectID)
            }
        }.fixedSize(horizontal: false, vertical: true)
    }
    private var policyConfiguration: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack {
                Text("Routing and delegation").font(NativeStyle.title)
                Spacer()
                Button("Done") { configuringPolicy = false }.keyboardShortcut(.cancelAction)
            }
            Grid(alignment: .leading, horizontalSpacing: 20, verticalSpacing: 20) {
                GridRow(alignment: .top) {
                    Text("Routing preset").foregroundStyle(.secondary).frame(width: 120, alignment: .leading)
                    VStack(alignment: .leading, spacing: 8) {
                        Picker("Routing preset", selection: Binding(get: { preset.id }, set: { id in
                            if let chosen = presets.first(where: { $0.id == id }) { preset = chosen }
                        })) {
                            ForEach(presetChoices) { choice in Text(choice.name).tag(choice.id) }
                        }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        Text(preset.summary).font(NativeStyle.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Edit presets…") {
                            presetEditor = NativeRoutingEditorSession(projectID: loadedProject, generation: projectGeneration, preset: preset, presets: presets)
                        }.buttonStyle(.plain).foregroundStyle(.tint)
                    }
                }
                GridRow(alignment: .top) {
                    Text("Delegation").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 8) {
                        Picker("Delegation", selection: $delegationMode) {
                            Text("Only when asked").tag("manual")
                            Text("Use team when helpful").tag("automatic")
                        }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        Text(delegationMode == "manual" ? "The lead delegates when you ask." : "The lead may use saved roles when helpful.")
                            .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            Spacer(minLength: 0)
            if !message.isEmpty {
                Text(message).font(NativeStyle.caption).foregroundStyle(failed ? .red : .secondary)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            Divider()
            HStack {
                Text(routingChanged ? "Changes are not applied yet." : "Saved for this project.")
                    .font(NativeStyle.caption).foregroundStyle(.secondary)
                Spacer()
                if routingChanged {
                    Button("Apply policy") { Task { await applyRouting() } }.buttonStyle(.borderedProminent)
                }
            }
        }.font(NativeStyle.body).padding(NativeStyle.pagePadding).frame(width: 560, height: 420)
            .disabled(saving || !client.connected || loadedProject != client.projectID).interactiveDismissDisabled(saving)
            .sheet(item: $presetEditor) { session in
                NativeRoutingPresetEditor(client: client, session: session,
                    isCurrent: { ownsProject(session.projectID, session.generation) },
                    onApplied: { applied, latest in
                        guard ownsProject(session.projectID, session.generation) else { return }
                        preset = applied; savedPreset = applied; presets = latest
                        message = "Routing preset applied."; failed = false
                    })
            }
    }
    private var roster: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Roles").font(NativeStyle.heading)
                Spacer()
                Text(String(roles.count)).font(NativeStyle.caption).foregroundStyle(.secondary)
            }
            List(selection: $selectedRoleID) {
                ForEach(roles) { role in
                    HStack(alignment: .top, spacing: 10) {
                        NativeHarnessIcon(harness: role.harness, size: 24)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(role.name.isEmpty ? "New role" : role.name).fontWeight(.medium)
                            Text(harnessName(role.harness) + (role.peerID == nil ? " · this Mac" : " · remote"))
                                .font(NativeStyle.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 8).tag(role.id)
                }
            }.listStyle(.plain).frame(maxHeight: .infinity)
            Button("Add role", systemImage: "plus") { addRole() }
                .buttonStyle(.bordered).disabled((workers.isEmpty && peers.isEmpty) || roles.count >= 30)
        }.frame(maxHeight: .infinity, alignment: .topLeading)
    }
    @ViewBuilder private var selectedEditor: some View {
        if selectedRoleID == nil {
            ContentUnavailableView("Select a role", systemImage: "person", description: Text("Edit its responsibility, harness and model."))
        }
        ForEach($roles) { $role in
            if role.id == selectedRoleID {
                GeometryReader { space in
                    ScrollView {
                        roleEditor($role, height: space.size.height)
                            .frame(maxWidth: .infinity, minHeight: space.size.height, alignment: .topLeading)
                    }
                }
            }
        }
    }
    private func roleEditor(_ role: Binding<NativeRoleDraft>, height: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 10) {
                NativeHarnessIcon(harness: role.wrappedValue.harness, size: 28)
                Text(role.wrappedValue.name.isEmpty ? "New role" : role.wrappedValue.name).font(NativeStyle.heading)
            }
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 14) {
                GridRow {
                    roleLabel("Role name")
                    TextField("Role name", text: role.name, prompt: Text("e.g. Code reviewer"))
                        .textFieldStyle(.roundedBorder)
                }
                GridRow {
                    roleLabel("Computer")
                    Picker("Computer", selection: Binding(get: { role.wrappedValue.peerID ?? "" }, set: { value in role.wrappedValue.peerID = value.isEmpty ? nil : value })) {
                        Text("This computer").tag("")
                        ForEach(peers, id: \.selfID) { peer in Text(peer["label"].string ?? "Remote computer").tag(peer["id"].string ?? "") }
                        if let saved = role.wrappedValue.peerID, !peers.contains(where: { $0["id"].string == saved }) { Text("Saved computer unavailable").tag(saved) }
                    }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                }
                GridRow {
                    roleLabel("Harness")
                    Picker("Harness", selection: role.harness) {
                        if role.wrappedValue.peerID != nil {
                            ForEach(remoteHarnesses, id: \.self) { harness in HStack { NativeHarnessIcon(harness: harness, size: 18); Text(harnessName(harness)) }.tag(harness) }
                            if !remoteHarnesses.contains(role.wrappedValue.harness) { Text(harnessName(role.wrappedValue.harness) + " · saved choice").tag(role.wrappedValue.harness) }
                        } else {
                            ForEach(workers, id: \.selfID) { worker in HStack { NativeHarnessIcon(harness: worker["id"].string ?? "", size: 18); Text(worker["name"].string ?? "Harness") }.tag(worker["id"].string ?? "") }
                            if !workers.contains(where: { $0["id"].string == role.wrappedValue.harness }) { Text(harnessName(role.wrappedValue.harness) + " · unavailable here").tag(role.wrappedValue.harness) }
                        }
                    }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                        .onChange(of: role.wrappedValue.harness) { _, _ in role.wrappedValue.model = "" }
                }
                GridRow {
                    roleLabel("Model (optional)")
                    TextField("Model (optional)", text: role.model, prompt: Text("Native default"))
                        .textFieldStyle(.roundedBorder)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                Text("Responsibility").fontWeight(.medium)
                TextEditor(text: role.responsibility).font(NativeStyle.document)
                    .scrollContentBackground(.hidden).padding(12).frame(height: max(180, height - 320))
                    .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(.quaternary))
                    .accessibilityLabel("Responsibility")
            }
            HStack {
                NativeDetailButton("Role details") {
                    Text(role.wrappedValue.peerID == nil ? "The selected harness uses its own account and permissions. An empty model uses its native default." : "This role stays on its saved remote owner. The owner checks model access and permissions at Start; saving does not verify availability.")
                        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.buttonStyle(.plain).foregroundStyle(.tint)
                Spacer()
                Button("Remove role", role: .destructive) {
                    let removedID = role.wrappedValue.id
                    roles.removeAll { $0.id == removedID }; selectedRoleID = roles.first?.id
                }.buttonStyle(.plain).foregroundStyle(.red)
            }
        }.padding(.trailing, 4)
    }
    private func roleLabel(_ title: String) -> some View {
        Text(title).foregroundStyle(.secondary).frame(width: 125, alignment: .leading)
    }
    private func harnessName(_ id: String) -> String {
        client.harnesses.first { $0["id"].string == id }?["name"].string ??
            ["codex": "Codex", "claude": "Claude Code", "muse": "Muse", "opencode": "OpenCode", "gemini": "Gemini", "cursor-agent": "Cursor", "zcode": "ZCode"][id] ?? (id.isEmpty ? "Choose harness" : id)
    }
    @ViewBuilder private var teamActions: some View {
        if !roles.isEmpty || savedRoleCount > 0 {
            Button("Save team") { Task { await saveTeam() } }.buttonStyle(.borderedProminent).disabled(loadedProject != client.projectID)
        }
    }
    private func addRole() {
        let id = UUID().uuidString
        roles.append(NativeRoleDraft(id: id, name: "", harness: workers.first?["id"].string ?? "", model: "", responsibility: "", peerID: nil))
        selectedRoleID = id
    }
    private func ownsProject(_ id: String, _ generation: UUID) -> Bool {
        id == client.projectID && id == loadedProject && generation == projectGeneration
    }
    private func loadPresets(projectID: String, generation: UUID) async {
        do {
            let response = try await client.request("/routing-presets")
            let latest = (response.array ?? []).compactMap(NativeRoutingPreset.init)
            guard ownsProject(projectID, generation) else { return }
            if !latest.isEmpty { presets = latest }
        } catch {
            guard ownsProject(projectID, generation) else { return }
            failed = true; message = "Could not load routing presets. " + error.localizedDescription
        }
    }
    private func saveTeam() async {
        guard !saving, loadedProject == client.projectID else { return }
        saving = true; failed = false; message = ""
        let id = loadedProject, generation = projectGeneration
        let submittedRoleCount = roles.count
        do {
            _ = try await client.request("/projects/\(id)", body: ["roles": roles.map(\.body)], method: "PATCH")
            await client.refresh()
            if ownsProject(id, generation) {
                savedRoleCount = submittedRoleCount
                message = "Team saved."
            }
        } catch {
            if ownsProject(id, generation) { failed = true; message = error.localizedDescription }
        }
        saving = false
    }
    private func applyRouting() async {
        guard !saving, loadedProject == client.projectID else { return }
        saving = true; failed = false; message = ""
        let id = loadedProject, generation = projectGeneration
        var body: [String: Any] = [:]
        if preset != savedPreset { body["routingPresetId"] = preset.id }
        if delegationMode != savedDelegationMode { body["delegationMode"] = delegationMode }
        do {
            let response = try await client.request("/projects/\(id)", body: body, method: "PATCH")
            await client.refresh()
            if ownsProject(id, generation) {
                preset = NativeRoutingPreset.projectPreset(response); savedPreset = preset
                delegationMode = response["delegationMode"].string ?? "manual"
                savedDelegationMode = delegationMode
                message = "Routing and delegation saved."
            }
        } catch {
            if ownsProject(id, generation) { failed = true; message = error.localizedDescription }
        }
        saving = false
    }
}

private struct NativeRoutingRules: Equatable {
    var routine = "efficient"
    var standard = "balanced"
    var hard = "capable"
    var adjustToAllowance = true
    var lowAllowancePercent = 20.0
    var highAllowancePercent = 50.0
    init() {}
    init(_ value: JSON) {
        routine = value["routine"].string ?? "efficient"
        standard = value["standard"].string ?? "balanced"
        hard = value["hard"].string ?? "capable"
        adjustToAllowance = value["adjustToAllowance"].bool ?? true
        lowAllowancePercent = value["lowAllowancePercent"].number ?? 20
        highAllowancePercent = value["highAllowancePercent"].number ?? 50
    }
    var valid: Bool {
        lowAllowancePercent.isFinite && highAllowancePercent.isFinite &&
        (0...100).contains(lowAllowancePercent) && (0...100).contains(highAllowancePercent) &&
        lowAllowancePercent < highAllowancePercent
    }
    var body: [String: Any] {
        ["routine": routine, "standard": standard, "hard": hard,
         "adjustToAllowance": adjustToAllowance, "lowAllowancePercent": lowAllowancePercent,
         "highAllowancePercent": highAllowancePercent]
    }
}

private struct NativeRoutingPreset: Identifiable, Equatable {
    var id: String
    var name: String
    var rules: NativeRoutingRules
    var builtIn: Bool { ["economical", "balanced", "best"].contains(id) }
    init(id: String, name: String, rules: NativeRoutingRules) {
        self.id = id; self.name = name; self.rules = rules
    }
    init?(_ value: JSON) {
        guard let id = value["id"].string, let name = value["name"].string,
              value["rules"].objectValue != nil else { return nil }
        self.init(id: id, name: name, rules: NativeRoutingRules(value["rules"]))
    }
    static let builtIns: [NativeRoutingPreset] = {
        var economical = NativeRoutingRules(); economical.standard = "efficient"
        economical.hard = "balanced"; economical.adjustToAllowance = false
        var best = NativeRoutingRules(); best.routine = "capable"; best.standard = "capable"
        best.adjustToAllowance = false
        return [NativeRoutingPreset(id: "economical", name: "Economical", rules: economical),
                NativeRoutingPreset(id: "balanced", name: "Balanced", rules: NativeRoutingRules()),
                NativeRoutingPreset(id: "best", name: "Best", rules: best)]
    }()
    static func projectPreset(_ project: JSON) -> NativeRoutingPreset {
        NativeRoutingPreset(project["routingPreset"]) ??
        builtIns.first { $0.id == project["preference"].string } ?? builtIns[1]
    }
    var summary: String {
        switch id {
        case "economical": return "Efficient for everyday work; stronger for hard tasks."
        case "balanced": return "Adjusts to task difficulty and remaining allowance."
        case "best": return "Prefers strong models, even when allowance is low."
        default: return rules.adjustToAllowance ? "Your saved model rules, adjusted to remaining allowance." : "Your saved model rules for each task difficulty."
        }
    }
    var body: [String: Any] { ["name": name.trimmingCharacters(in: .whitespacesAndNewlines), "rules": rules.body] }
}

private struct NativeRoutingEditorSession: Identifiable {
    let id = UUID()
    let projectID: String
    let generation: UUID
    let preset: NativeRoutingPreset
    let presets: [NativeRoutingPreset]
}

private struct NativeRoutingPresetEditor: View {
    @ObservedObject var client: AgentKlarClient
    let session: NativeRoutingEditorSession
    let isCurrent: () -> Bool
    let onApplied: (NativeRoutingPreset, [NativeRoutingPreset]) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var presets: [NativeRoutingPreset]
    @State private var choice: String
    @State private var draft: NativeRoutingPreset
    @State private var lowInput: String
    @State private var highInput: String
    @State private var busy = false
    @State private var message = ""
    @State private var failed = false
    init(client: AgentKlarClient, session: NativeRoutingEditorSession,
         isCurrent: @escaping () -> Bool,
         onApplied: @escaping (NativeRoutingPreset, [NativeRoutingPreset]) -> Void) {
        self.client = client; self.session = session; self.isCurrent = isCurrent; self.onApplied = onApplied
        _presets = State(initialValue: session.presets)
        _choice = State(initialValue: session.preset.id)
        _draft = State(initialValue: session.preset)
        _lowInput = State(initialValue: Self.thresholdText(session.preset.rules.lowAllowancePercent))
        _highInput = State(initialValue: Self.thresholdText(session.preset.rules.highAllowancePercent))
    }
    private var editingBuiltIn: Bool { draft.builtIn && choice != "new" }
    private var latestPreset: NativeRoutingPreset? { presets.first { $0.id == choice } }
    private var valid: Bool {
        let name = draft.name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !name.isEmpty && name.utf16.count <= 80 && draft.rules.valid &&
            !name.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format }
    }
    private var availablePresets: [NativeRoutingPreset] {
        var choices = presets.map { $0.id == draft.id ? draft : $0 }
        if choice != "new" && !choices.contains(where: { $0.id == draft.id }) { choices.append(draft) }
        return choices
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Routing presets").font(NativeStyle.title)
                Spacer()
                Button("Cancel") { dismiss() }.disabled(busy).keyboardShortcut(.cancelAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 16) {
                        GridRow(alignment: .top) {
                            presetLabel("Preset")
                            VStack(alignment: .leading, spacing: 8) {
                                Picker("Preset", selection: Binding(get: { choice }, set: { select($0) })) {
                                    ForEach(availablePresets) { preset in
                                        Text(preset.name + (preset.builtIn ? " · built-in" : "")).tag(preset.id)
                                    }
                                    Text("New preset").tag("new")
                                }.labelsHidden().frame(maxWidth: .infinity, alignment: .leading)
                                HStack {
                                    Text(editingBuiltIn ? "Built-in presets are read only." : "Save a named preset for future projects.")
                                        .font(NativeStyle.caption).foregroundStyle(.secondary)
                                    Spacer()
                                    if choice != "new" {
                                        Button("Make a copy") { makeCopy() }.buttonStyle(.plain).foregroundStyle(.tint)
                                    }
                                }
                                if let latest = latestPreset, latest != draft, choice == session.preset.id, draft == session.preset {
                                    Button("Load latest saved preset") { setDraft(latest) }.buttonStyle(.plain).foregroundStyle(.tint)
                                }
                            }
                        }
                        GridRow {
                            presetLabel("Name")
                            TextField("Name", text: $draft.name, prompt: Text("My preset"))
                                .textFieldStyle(.roundedBorder).disabled(editingBuiltIn)
                        }
                        GridRow {
                            presetLabel("Routine tasks")
                            strengthPicker("Routine tasks", selection: $draft.rules.routine).labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading).disabled(editingBuiltIn)
                        }
                        GridRow {
                            presetLabel("Standard tasks")
                            strengthPicker("Standard tasks", selection: $draft.rules.standard).labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading).disabled(editingBuiltIn)
                        }
                        GridRow {
                            presetLabel("Hard tasks")
                            strengthPicker("Hard tasks", selection: $draft.rules.hard).labelsHidden()
                                .frame(maxWidth: .infinity, alignment: .leading).disabled(editingBuiltIn)
                        }
                        GridRow {
                            presetLabel("Allowance")
                            Toggle("Adjust automatically", isOn: $draft.rules.adjustToAllowance)
                                .toggleStyle(.switch).controlSize(.small).disabled(editingBuiltIn)
                                .accessibilityLabel("Adjust to remaining allowance")
                        }
                        if draft.rules.adjustToAllowance {
                            GridRow {
                                presetLabel("Low (%)")
                                TextField("Low (%)", text: $lowInput).textFieldStyle(.roundedBorder)
                                    .frame(width: 100).disabled(editingBuiltIn)
                                    .onChange(of: lowInput) { _, value in draft.rules.lowAllowancePercent = Double(value.trimmingCharacters(in: .whitespaces)) ?? .nan }
                            }
                            GridRow {
                                presetLabel("High (%)")
                                TextField("High (%)", text: $highInput).textFieldStyle(.roundedBorder)
                                    .frame(width: 100).disabled(editingBuiltIn)
                                    .onChange(of: highInput) { _, value in draft.rules.highAllowancePercent = Double(value.trimmingCharacters(in: .whitespaces)) ?? .nan }
                            }
                        }
                    }
                    Text(allowanceSummary).font(NativeStyle.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    if !draft.rules.valid {
                        Text("Use percentages from 0 to 100. Low must be less than high.")
                            .font(NativeStyle.caption).foregroundStyle(.red)
                    }
                    Text("Saved pins stay fixed. Automatic choices still need native access. Quality and dollar cost are unverified; no dollar budget is enforced.")
                        .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if !message.isEmpty {
                        Text(message).font(NativeStyle.caption).foregroundStyle(failed ? .red : .secondary)
                            .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Text("Applying changes only this project's preset. Other projects keep their saved copy.")
                    .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 12)
                Button(editingBuiltIn ? "Use preset" : "Save and use") { Task { await saveAndUse() } }
                    .buttonStyle(.borderedProminent).disabled(!valid || busy || !client.connected || !isCurrent())
            }
        }.font(NativeStyle.body).padding(24).frame(width: 580, height: 530)
            .disabled(busy).interactiveDismissDisabled(busy)
            .task { await reloadPresets() }
    }
    private func presetLabel(_ title: String) -> some View {
        Text(title).foregroundStyle(.secondary).frame(width: 120, alignment: .leading)
    }
    private func strengthPicker(_ title: String, selection: Binding<String>) -> some View {
        Picker(title, selection: selection) {
            Text("Efficient").tag("efficient")
            Text("Balanced").tag("balanced")
            Text("Strong").tag("capable")
        }
    }
    private var allowanceSummary: String {
        guard draft.rules.adjustToAllowance else { return "Uses your chosen strength for each task difficulty." }
        guard draft.rules.valid else { return "Adjusts strengths using fresh native allowance." }
        let low = draft.rules.lowAllowancePercent.formatted(), high = draft.rules.highAllowancePercent.formatted()
        return "At \(low)% or less: Efficient; hard tasks use Balanced. At \(high)% or more: standard and hard tasks use Strong; routine keeps your choice. Allowance older than five minutes is ignored."
    }
    private func select(_ id: String) {
        choice = id
        message = ""; failed = false
        if id == "new" {
            setDraft(NativeRoutingPreset(id: "new", name: "", rules: NativeRoutingRules()))
        } else if let selected = presets.first(where: { $0.id == id }) { setDraft(selected) }
    }
    private func makeCopy() {
        let source = draft
        choice = "new"
        message = ""; failed = false
        setDraft(NativeRoutingPreset(id: "new", name: source.name + " copy", rules: source.rules))
    }
    private static func thresholdText(_ value: Double) -> String {
        value.isFinite && value.rounded() == value ? String(Int(value)) : String(value)
    }
    private func setDraft(_ value: NativeRoutingPreset) {
        draft = value
        lowInput = Self.thresholdText(value.rules.lowAllowancePercent)
        highInput = Self.thresholdText(value.rules.highAllowancePercent)
    }
    private func reloadPresets() async {
        do {
            let response = try await client.request("/routing-presets")
            guard isCurrent() else { return }
            let latest = (response.array ?? []).compactMap(NativeRoutingPreset.init)
            if !latest.isEmpty { presets = latest }
        } catch {
            guard isCurrent() else { return }
            failed = true; message = "Could not refresh presets. " + error.localizedDescription
        }
    }
    private func saveAndUse() async {
        guard !busy, valid, isCurrent() else { return }
        busy = true; failed = false; message = ""
        defer { busy = false }
        var savedToRegistry = false
        do {
            var chosen = draft
            if !editingBuiltIn {
                let path = choice == "new" ? "/routing-presets" : "/routing-presets/\(choice)"
                let response = try await client.request(path, body: draft.body, method: choice == "new" ? "POST" : "PUT")
                guard isCurrent() else { return }
                guard let saved = NativeRoutingPreset(response) else { throw LocalError.message("The service returned an invalid routing preset.") }
                chosen = saved
                savedToRegistry = true
                // Keep the saved ID so a failed project apply can be retried without creating another copy.
                choice = saved.id; setDraft(saved)
                presets.removeAll { $0.id == saved.id }; presets.append(saved)
            }
            guard isCurrent() else { return }
            let project = try await client.request("/projects/\(session.projectID)", body: ["routingPresetId": chosen.id], method: "PATCH")
            await client.refresh()
            guard isCurrent() else { return }
            onApplied(NativeRoutingPreset.projectPreset(project), presets)
            dismiss()
        } catch {
            guard isCurrent() else { return }
            failed = true
            message = savedToRegistry ? "Preset saved. Could not apply it to this project: " + error.localizedDescription : error.localizedDescription
        }
    }
}

private struct NativeRoleDraft: Identifiable {
    var id: String
    var name: String
    var harness: String
    var model: String
    var responsibility: String
    var peerID: String?
    init(id: String, name: String, harness: String, model: String, responsibility: String, peerID: String?) {
        self.id = id; self.name = name; self.harness = harness; self.model = model; self.responsibility = responsibility; self.peerID = peerID
    }
    init(_ value: JSON) {
        id = value["id"].string ?? UUID().uuidString; name = value["name"].string ?? ""
        harness = value["harness"].string ?? ""; model = value["model"].string ?? ""
        responsibility = value["responsibility"].string ?? ""; peerID = value["peerId"].string
    }
    var body: [String: Any] {
        var result: [String: Any] = ["id": id, "name": name, "harness": harness, "responsibility": responsibility]
        if !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { result["model"] = model.trimmingCharacters(in: .whitespacesAndNewlines) }
        if let peerID { result["peerId"] = peerID }
        return result
    }
}
