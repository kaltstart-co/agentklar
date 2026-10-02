import SwiftUI
import AppKit

struct TeamView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var selectedRoleID: String?
    @State private var roles: [NativeRoleDraft] = []
    @State private var preference = "balanced"
    @State private var loadedProject = ""
    @State private var saving = false
    @State private var message = ""
    @State private var failed = false
    private var workers: [JSON] { client.harnesses.filter { $0["available"].bool == true && $0["workerSupported"].bool == true } }
    private var peers: [JSON] { (client.snapshot["peers"].array ?? []).filter { $0["projectId"].string == client.projectID } }
    private let remoteHarnesses = ["codex", "claude", "muse", "opencode", "gemini", "cursor-agent", "zcode"]
    var body: some View {
        if client.projectID.isEmpty {
            ContentUnavailableView("Choose a project", systemImage: "person.2", description: Text("Save roles and native model pins for this project."))
        } else {
            VStack(alignment: .leading, spacing: 24) {
                NativePageHeader(title: "Team", subtitle: "Saved roles, responsibilities and native model pins.") { teamActions }
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 16) { preferenceControls }.fixedSize(horizontal: true, vertical: false)
                    VStack(alignment: .leading, spacing: 8) { preferenceControls }
                }
                if !message.isEmpty { Text(message).foregroundStyle(failed ? .red : .secondary).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
                if roles.isEmpty {
                    NativeEmptyState("Build your team", systemImage: "person.2", description: "Add roles for the work you delegate often.") {
                        Button("Add role", systemImage: "plus") { addRole() }.disabled((workers.isEmpty && peers.isEmpty) || roles.count >= 30)
                    }
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: 24) {
                            roster.frame(width: 220)
                            selectedEditor.frame(minWidth: 320, maxWidth: .infinity)
                        }
                        ScrollView {
                            VStack(alignment: .leading, spacing: 16) {
                                roster.frame(height: 160)
                                selectedEditor
                            }
                        }
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }.font(NativeStyle.body).padding(NativeStyle.pagePadding).disabled(saving || !client.connected)
            .task(id: client.projectID) {
                loadedProject = client.projectID
                preference = client.project["preference"].string ?? "balanced"
                roles = (client.project["roles"].array ?? []).map(NativeRoleDraft.init)
                selectedRoleID = roles.first?.id
                message = ""
            }
        }
    }
    @ViewBuilder private var preferenceControls: some View {
        Picker("Routing preference", selection: $preference) {
            Text("Economical").tag("economical"); Text("Balanced").tag("balanced"); Text("Best capability").tag("best")
        }.fixedSize(horizontal: true, vertical: false)
        Text(preferenceSummary).font(NativeStyle.caption).foregroundStyle(.secondary)
        NativeDetailButton("About routing preference") {
            Text("This preference guides automatic routing. Saved role and model pins stay fixed. Dollar cost is unknown; this setting does not enforce a budget.")
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
    private var preferenceSummary: String {
        switch preference {
        case "economical": return "Favor efficient workers for everyday work."
        case "best": return "Favor the strongest suitable worker."
        default: return "Balance capability with efficient use."
        }
    }
    private func harnessName(_ id: String) -> String {
        client.harnesses.first { $0["id"].string == id }?["name"].string ??
            ["codex": "Codex", "claude": "Claude Code", "muse": "Muse", "opencode": "OpenCode", "gemini": "Gemini", "cursor-agent": "Cursor", "zcode": "ZCode"][id] ?? (id.isEmpty ? "Choose harness" : id)
    }
    @ViewBuilder private var teamActions: some View {
        Button("Add role", systemImage: "plus") { addRole() }.disabled((workers.isEmpty && peers.isEmpty) || roles.count >= 30)
        Button("Save team") { Task { await save() } }.buttonStyle(.borderedProminent).disabled(loadedProject != client.projectID)
    }
    private func addRole() {
        let id = UUID().uuidString
        roles.append(NativeRoleDraft(id: id, name: "", harness: workers.first?["id"].string ?? "", model: "", responsibility: "", peerID: nil))
        selectedRoleID = id
    }
    private func save() async {
        guard !saving, loadedProject == client.projectID else { return }
        saving = true; failed = false; message = ""
        let id = loadedProject
        do {
            _ = try await client.request("/projects/\(id)", body: ["preference": preference, "roles": roles.map(\.body)], method: "PATCH")
            await client.refresh()
            if id == client.projectID { message = "Team saved." }
        } catch { failed = true; message = error.localizedDescription }
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
