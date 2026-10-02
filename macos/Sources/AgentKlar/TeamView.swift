import SwiftUI
import AppKit

struct TeamView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var selectedRoleID: String?
    @State private var roles: [NativeRoleDraft] = []
    @State private var preference = "balanced"
    @State private var savedPreference = "balanced"
    @State private var loadedProject = ""
    @State private var projectGeneration = UUID()
    @State private var saving = false
    @State private var message = ""
    @State private var failed = false
    @State private var showingRoutingDetails = false
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
                        ViewThatFits(in: .horizontal) {
                            HStack(alignment: .top, spacing: 24) {
                                roster.frame(width: 220, height: 360)
                                selectedEditor.frame(minWidth: 320, maxWidth: .infinity)
                            }
                            VStack(alignment: .leading, spacing: 16) {
                                roster.frame(height: 160)
                                selectedEditor
                            }
                        }.frame(maxWidth: .infinity)
                    }
                }.font(NativeStyle.body).padding(NativeStyle.pagePadding).disabled(saving || !client.connected)
            }
            .task(id: client.projectID) {
                loadedProject = client.projectID
                projectGeneration = UUID()
                preference = client.project["preference"].string ?? "balanced"
                savedPreference = preference
                roles = (client.project["roles"].array ?? []).map(NativeRoleDraft.init)
                selectedRoleID = roles.first?.id
                message = ""
            }
        }
    }
    private var preferenceControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            NativeSectionTitle(title: "Routing preference", subtitle: "Choose how automatic routing selects a model for this project.")
            HStack(alignment: .top, spacing: 12) { preferenceOptions }
            VStack(alignment: .leading, spacing: 6) {
                Text("Rules for \(preferenceTitle)").font(NativeStyle.heading)
                Text(preferenceRules).font(NativeStyle.caption).lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Saved pins stay fixed. Blocked, unavailable or exhausted automatic choices are skipped. Allowance is stale after five minutes. No dollar budget is enforced.")
                .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 12) {
                Button("Save preference") { Task { await save(preferenceOnly: true) } }
                    .buttonStyle(.borderedProminent)
                    .fixedSize()
                    .disabled(loadedProject != client.projectID || preference == savedPreference)
                Text(preference == savedPreference ? "Saved for this project." : "Unsaved preference.")
                    .font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button("Routing details") { showingRoutingDetails = true }.buttonStyle(.bordered)
            }
            Text("Save preference updates routing. Save team also saves your roles.")
                .font(NativeStyle.caption).foregroundStyle(.secondary)
        }
        .sheet(isPresented: $showingRoutingDetails) { routingDetails }
    }
    @ViewBuilder private var preferenceOptions: some View {
        preferenceOption("economical", title: "Economical", summary: "Uses efficient models for everyday work and stronger models for hard tasks.")
        preferenceOption("balanced", title: "Balanced", summary: "Adjusts model strength to task difficulty and fresh remaining allowance.")
        preferenceOption("best", title: "Best capability", summary: "Prefers the strongest reviewed tier, even when allowance is low.")
    }
    private func preferenceOption(_ value: String, title: String, summary: String) -> some View {
        Button {
            preference = value
        } label: {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text(title).font(NativeStyle.heading)
                    Spacer(minLength: 8)
                    Image(systemName: preference == value ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(preference == value ? Color.accentColor : Color.secondary)
                }
                Text(summary).font(NativeStyle.body).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(minWidth: 130, maxWidth: .infinity, alignment: .leading)
            .frame(height: 96, alignment: .topLeading)
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.accentColor.opacity(preference == value ? 0.09 : 0)))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(preference == value ? Color.accentColor : Color.secondary.opacity(0.3), lineWidth: preference == value ? 2 : 1))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain).foregroundStyle(.primary)
        .accessibilityLabel(title)
        .accessibilityAddTraits(preference == value ? .isSelected : [])
        .accessibilityValue(preference == value ? "Selected" : "Not selected")
        .accessibilityHint(summary + " Select this preference, then choose Save preference or Save team.")
    }
    private var preferenceTitle: String {
        switch preference {
        case "economical": return "Economical"
        case "best": return "Best capability"
        default: return "Balanced"
        }
    }
    private var preferenceRules: String {
        switch preference {
        case "economical":
            return "Routine and standard tasks: efficient tier. Hard tasks: balanced tier.\nRemaining allowance does not change these targets."
        case "best":
            return "All task difficulties: capable tier.\nLow remaining allowance does not lower this target."
        default:
            return "Usual targets: routine = efficient; standard = balanced; hard = capable.\n20% or less remaining: efficient; hard tasks use balanced.\n50% or more remaining: capable; routine tasks use efficient."
        }
    }
    private var routingDetails: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Routing details").font(NativeStyle.title)
                Spacer()
                Button("Done") { showingRoutingDetails = false }.keyboardShortcut(.defaultAction)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    routingNote("Model groups", "Examples: efficient = Luna / Haiku; balanced = Sol / Sonnet; capable = Astra / Opus. These are reviewed policy groups. Actual quality and dollar cost are unverified. Routing uses the nearest suitable reviewed tier when its target is unavailable.")
                    routingNote("Fresh allowance", "Balanced uses the lowest remaining percentage across a model's applicable native allowance windows. Data older than five minutes is ignored. If allowance is unknown, it uses the usual targets.")
                    routingNote("Pins and recovery", "Task, role and computer pins stay fixed. Fresh blocked allowance stops a pinned choice. An exhausted allowance keeps the pin with a warning. A passed reset time does not confirm recovery; refresh native usage to check it.")
                }.frame(maxWidth: .infinity, alignment: .leading)
            }
        }.font(NativeStyle.body).padding(24).frame(width: 540, height: 380)
    }
    private func routingNote(_ title: String, _ text: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(NativeStyle.heading)
            Text(text).font(NativeStyle.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
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
        Button("Save team") { Task { await save(preferenceOnly: false) } }.buttonStyle(.borderedProminent).disabled(loadedProject != client.projectID)
    }
    private func addRole() {
        let id = UUID().uuidString
        roles.append(NativeRoleDraft(id: id, name: "", harness: workers.first?["id"].string ?? "", model: "", responsibility: "", peerID: nil))
        selectedRoleID = id
    }
    private func save(preferenceOnly: Bool) async {
        guard !saving, loadedProject == client.projectID else { return }
        saving = true; failed = false; message = ""
        let id = loadedProject
        let generation = projectGeneration
        let submittedPreference = preference
        var body: [String: Any] = ["preference": submittedPreference]
        if !preferenceOnly { body["roles"] = roles.map(\.body) }
        do {
            _ = try await client.request("/projects/\(id)", body: body, method: "PATCH")
            await client.refresh()
            if id == client.projectID && generation == projectGeneration {
                savedPreference = submittedPreference
                message = preferenceOnly ? "Routing preference saved." : "Roles and routing preference saved."
            }
        } catch {
            if id == client.projectID && generation == projectGeneration {
                failed = true; message = error.localizedDescription
            }
        }
        saving = false
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
