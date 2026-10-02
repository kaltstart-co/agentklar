import SwiftUI

struct TeamView: View {
    @ObservedObject var client: AgentKlarClient
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
            Form {
                Section {
                    Text("Team").font(.title2.weight(.semibold))
                    Text("Save which native worker should do each kind of work. Your main harness stays in charge.").foregroundStyle(.secondary)
                    Picker("Cost preference", selection: $preference) {
                        Text("Economical").tag("economical"); Text("Balanced").tag("balanced"); Text("Best capability").tag("best")
                    }
                    Text("This preference guides automatic routing through the service. It does not enforce a budget.").font(.caption).foregroundStyle(.secondary)
                }
                ForEach($roles) { $role in
                    Section(role.name.isEmpty ? "New role" : role.name) {
                        TextField("Role name", text: $role.name)
                        Picker("Computer", selection: Binding(get: { role.peerID ?? "" }, set: { value in role.peerID = value.isEmpty ? nil : value })) {
                            Text("This computer").tag("")
                            ForEach(peers, id: \.selfID) { peer in Text(peer["label"].string ?? "Remote computer").tag(peer["id"].string ?? "") }
                            if let saved = role.peerID, !peers.contains(where: { $0["id"].string == saved }) { Text("Saved mapping unavailable").tag(saved) }
                        }
                        if role.peerID != nil { Text("Explicit remote pin. The owner checks native model access and permission rules when starting work. Saving this role does not verify remote availability.").font(.caption).foregroundStyle(.secondary) }
                        Picker("Harness", selection: $role.harness) {
                            if role.peerID != nil {
                                ForEach(remoteHarnesses, id: \.self) { harness in HStack { NativeHarnessIcon(harness: harness, size: 18); Text(harness) }.tag(harness) }
                                if !remoteHarnesses.contains(role.harness) { Text("\(role.harness) · saved pin").tag(role.harness) }
                            } else {
                                ForEach(workers, id: \.selfID) { worker in HStack { NativeHarnessIcon(harness: worker["id"].string ?? "", size: 18); Text(worker["name"].string ?? "Harness") }.tag(worker["id"].string ?? "") }
                                if !workers.contains(where: { $0["id"].string == role.harness }) { Text("\(role.harness) · saved pin unavailable locally").tag(role.harness) }
                            }
                        }
                        .onChange(of: role.harness) { _, _ in role.model = "" }
                        TextField("Model (optional native pin)", text: $role.model)
                        TextEditor(text: $role.responsibility).frame(minHeight: 70).accessibilityLabel("Responsibility")
                        Button("Remove role", role: .destructive) { roles.removeAll { $0.id == role.id } }
                    }
                }
                Section {
                    if roles.isEmpty { Text("No saved roles yet.").foregroundStyle(.secondary) }
                    HStack {
                        Button("Add role", systemImage: "plus") {
                            roles.append(NativeRoleDraft(id: UUID().uuidString, name: "", harness: workers.first?["id"].string ?? "", model: "", responsibility: "", peerID: nil))
                        }.disabled((workers.isEmpty && peers.isEmpty) || roles.count >= 30)
                        Spacer()
                        Button("Save team") { Task { await save() } }.disabled(loadedProject != client.projectID)
                    }
                    if !message.isEmpty { Text(message).foregroundStyle(failed ? .red : .secondary).textSelection(.enabled) }
                }
            }.formStyle(.grouped).disabled(saving || !client.connected)
            .task(id: client.projectID) {
                loadedProject = client.projectID
                preference = client.project["preference"].string ?? "balanced"
                roles = (client.project["roles"].array ?? []).map(NativeRoleDraft.init)
                message = ""
            }
        }
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
