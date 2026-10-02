import SwiftUI
import AppKit

struct TeamView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var selectedRoleID: String?
    @State private var roles: [NativeRoleDraft] = []
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
    private var workers: [JSON] { client.harnesses.filter { $0["available"].bool == true && $0["workerSupported"].bool == true } }
    private var peers: [JSON] { (client.snapshot["peers"].array ?? []).filter { $0["projectId"].string == client.projectID } }
    private let remoteHarnesses = ["codex", "claude", "muse", "opencode", "gemini", "cursor-agent", "zcode"]
    var body: some View {
        if client.projectID.isEmpty {
            ContentUnavailableView("Choose a project", systemImage: "person.2", description: Text("Save roles and native model pins for this project."))
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    NativePageHeader(title: "Team", subtitle: "Saved roles, responsibilities and native model pins.") { teamActions }
                    preferenceControls
                    if !message.isEmpty { Text(message).foregroundStyle(failed ? .red : .secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                    if roles.isEmpty {
                        NativeEmptyState("Build your team", systemImage: "person.2", description: "Add roles for the work you delegate often.") {
                            Button("Add role", systemImage: "plus") { addRole() }.disabled((workers.isEmpty && peers.isEmpty) || roles.count >= 30)
                        }
                    } else {
                        HStack(alignment: .top, spacing: 24) {
                            roster.frame(width: 200, height: 360)
                            selectedEditor.frame(minWidth: 280, maxWidth: .infinity)
                        }.frame(maxWidth: .infinity)
                    }
                }.font(NativeStyle.body).padding(NativeStyle.pagePadding).disabled(saving || !client.connected)
            }
            .task(id: client.projectID) {
                loadedProject = client.projectID
                projectGeneration = UUID()
                presetEditor = nil
                preset = NativeRoutingPreset.projectPreset(client.project)
                savedPreset = preset
                delegationMode = client.project["delegationMode"].string ?? "manual"
                savedDelegationMode = delegationMode
                presets = NativeRoutingPreset.builtIns
                roles = (client.project["roles"].array ?? []).map(NativeRoleDraft.init)
                selectedRoleID = roles.first?.id
                message = ""
                await loadPresets(projectID: loadedProject, generation: projectGeneration)
            }
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
    }
    private var routingChanged: Bool { preset != savedPreset || delegationMode != savedDelegationMode }
    private var presetChoices: [NativeRoutingPreset] {
        var choices = presets.map { $0.id == preset.id ? preset : $0 }
        if !choices.contains(where: { $0.id == preset.id }) { choices.append(preset) }
        return choices
    }
    private var preferenceControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                Picker("Routing preset", selection: Binding(get: { preset.id }, set: { id in
                    if let chosen = presets.first(where: { $0.id == id }) { preset = chosen }
                })) {
                    ForEach(presetChoices) { choice in Text(choice.name).tag(choice.id) }
                }.frame(width: 250)
                Text(preset.summary).font(NativeStyle.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).lineLimit(2)
                Button("Edit presets…") {
                    presetEditor = NativeRoutingEditorSession(projectID: loadedProject, generation: projectGeneration, preset: preset, presets: presets)
                }.buttonStyle(.plain).foregroundStyle(Color.accentColor).disabled(loadedProject != client.projectID)
            }
            HStack(spacing: 12) {
                Picker("Delegation", selection: $delegationMode) {
                    Text("Only when asked").tag("manual")
                    Text("Use team when helpful").tag("automatic")
                }.frame(width: 250)
                Text(delegationMode == "manual" ? "Delegate work when you ask." : "The lead may use saved roles when helpful.")
                    .font(NativeStyle.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).lineLimit(2)
                if routingChanged {
                    Button("Apply policy") { Task { await applyRouting() } }
                        .buttonStyle(.borderedProminent).disabled(loadedProject != client.projectID)
                }
            }
        }.buttonStyle(.bordered)
    }
    private var roster: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Roles").font(NativeStyle.heading)
            List(selection: $selectedRoleID) {
                ForEach(roles) { role in
                    HStack(alignment: .top, spacing: 10) {
                        NativeHarnessIcon(harness: role.harness, size: 24)
                        VStack(alignment: .leading, spacing: 4) {
                            Text(role.name.isEmpty ? "New role" : role.name).fontWeight(.medium)
                            Text(harnessName(role.harness) + (role.peerID == nil ? " · this Mac" : " · remote owner"))
                                .font(NativeStyle.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 6).tag(role.id)
                }
            }.listStyle(.plain)
        }
    }
    @ViewBuilder private var selectedEditor: some View {
        if selectedRoleID == nil { Text("Select a role to edit its responsibility and native pins.").foregroundStyle(.secondary) }
        ForEach($roles) { $role in
            if role.id == selectedRoleID {
                VStack(alignment: .leading, spacing: 12) {
                    Text(role.name.isEmpty ? "New role" : role.name).font(NativeStyle.heading)
                    Form {
                        TextField("Role name", text: $role.name)
                        Picker("Computer", selection: Binding(get: { role.peerID ?? "" }, set: { value in role.peerID = value.isEmpty ? nil : value })) {
                            Text("This computer").tag("")
                            ForEach(peers, id: \.selfID) { peer in Text(peer["label"].string ?? "Remote computer").tag(peer["id"].string ?? "") }
                            if let saved = role.peerID, !peers.contains(where: { $0["id"].string == saved }) { Text("Saved mapping unavailable").tag(saved) }
                        }

                        Picker("Harness", selection: $role.harness) {
                            if role.peerID != nil {
                                ForEach(remoteHarnesses, id: \.self) { harness in HStack { NativeHarnessIcon(harness: harness, size: 18); Text(harnessName(harness)) }.tag(harness) }
                                if !remoteHarnesses.contains(role.harness) { Text("\(harnessName(role.harness)) · saved pin").tag(role.harness) }
                            } else {
                                ForEach(workers, id: \.selfID) { worker in HStack { NativeHarnessIcon(harness: worker["id"].string ?? "", size: 18); Text(worker["name"].string ?? "Harness") }.tag(worker["id"].string ?? "") }
                                if !workers.contains(where: { $0["id"].string == role.harness }) { Text("\(harnessName(role.harness)) · saved pin unavailable locally").tag(role.harness) }
                            }
                        }
                        .onChange(of: role.harness) { _, _ in role.model = "" }
                        TextField("Model pin (optional)", text: $role.model)
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Responsibility").foregroundStyle(.secondary)
                            TextEditor(text: $role.responsibility).font(NativeStyle.body)
                                .scrollContentBackground(.hidden).padding(16).frame(height: 160)
                                .accessibilityLabel("Responsibility")
                        }
                        NativeDetailButton("Role details") {
                            Text(role.peerID == nil ? "The selected native harness uses its own account and permissions. An empty model pin uses its native default." : "This role stays on its saved remote owner. The owner checks native model access and permissions at Start; saving does not verify availability.")
                                .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                        }
                        Button("Remove role", role: .destructive) { roles.removeAll { $0.id == role.id }; selectedRoleID = roles.first?.id }
                    }.formStyle(.columns)
                }
            }
        }
    }
    private func harnessName(_ id: String) -> String {
        client.harnesses.first { $0["id"].string == id }?["name"].string ??
            ["codex": "Codex", "claude": "Claude Code", "muse": "Muse", "opencode": "OpenCode", "gemini": "Gemini", "cursor-agent": "Cursor", "zcode": "ZCode"][id] ?? (id.isEmpty ? "Choose harness" : id)
    }
    @ViewBuilder private var teamActions: some View {
        Button("Add role", systemImage: "plus") { addRole() }.disabled((workers.isEmpty && peers.isEmpty) || roles.count >= 30)
        Button("Save team") { Task { await saveTeam() } }.buttonStyle(.borderedProminent).disabled(loadedProject != client.projectID)
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
        do {
            _ = try await client.request("/projects/\(id)", body: ["roles": roles.map(\.body)], method: "PATCH")
            await client.refresh()
            if ownsProject(id, generation) { message = "Team saved." }
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
                    Form {
                        Picker("Preset", selection: Binding(get: { choice }, set: { select($0) })) {
                            ForEach(availablePresets) { preset in
                                Text(preset.name + (preset.builtIn ? " · built-in" : "")).tag(preset.id)
                            }
                            Text("New preset").tag("new")
                        }
                        HStack {
                            Text(editingBuiltIn ? "Built-in presets are read only." : "Save a named preset for future projects.")
                                .font(NativeStyle.caption).foregroundStyle(.secondary)
                            Spacer()
                            if choice != "new" { Button("Make a copy") { makeCopy() } }
                        }
                        if let latest = latestPreset, latest != draft, choice == session.preset.id, draft == session.preset {
                            Button("Load latest saved preset") { setDraft(latest) }
                        }
                        Group {
                            TextField("Name", text: $draft.name, prompt: Text("My preset"))
                            strengthPicker("Routine tasks", selection: $draft.rules.routine)
                            strengthPicker("Standard tasks", selection: $draft.rules.standard)
                            strengthPicker("Hard tasks", selection: $draft.rules.hard)
                            Toggle("Adjust to remaining allowance", isOn: $draft.rules.adjustToAllowance)
                            if draft.rules.adjustToAllowance {
                                HStack {
                                    TextField("Low (%)", text: $lowInput)
                                        .onChange(of: lowInput) { _, value in draft.rules.lowAllowancePercent = Double(value.trimmingCharacters(in: .whitespaces)) ?? .nan }
                                    TextField("High (%)", text: $highInput)
                                        .onChange(of: highInput) { _, value in draft.rules.highAllowancePercent = Double(value.trimmingCharacters(in: .whitespaces)) ?? .nan }
                                }
                            }
                        }.disabled(editingBuiltIn)
                    }.formStyle(.columns)
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
