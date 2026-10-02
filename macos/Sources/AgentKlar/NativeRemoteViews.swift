import SwiftUI
import Foundation

struct NativeDevicesView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var settings: JSON = .null
    @State private var human: JSON = .null
    @State private var working = false
    @State private var message = ""
    @State private var label = ""
    @State private var host = ""
    @State private var command = "agentklar"
    @State private var localProject = ""
    @State private var code = ""
    @State private var sourceDevice = ""
    @State private var grantProject = ""
    @State private var exported = ""
    @State private var humanPeer = ""
    @State private var humanCode = ""
    @State private var humanExport = ""
    @State private var generation = 0
    private var peers: [JSON] { settings["peers"].array ?? [] }
    private var projects: [JSON] { settings["projects"].array ?? [] }

    var body: some View {
        Form {
            Section("Other computers") {
                Text("Each computer keeps its own projects, native accounts and workers. Saving a connection does not test it or start work.").foregroundStyle(.secondary)
                Text("Install AgentKlar on both computers, register both project folders, and verify SSH access and the owner computer's identity yourself.").font(.caption)
                LabeledContent("This computer", value: settings["device"]["label"].string ?? "Unknown")
                Text(settings["device"]["id"].string ?? "").textSelection(.enabled).font(.caption)
                Button("Refresh saved connections") { perform { try await load() } }
                if !message.isEmpty { Text(message).foregroundStyle(.secondary) }
            }
            ForEach(peers, id: \.selfID) { peer in
                Section(peer["label"].string ?? "Computer") {
                    LabeledContent("SSH host", value: peer["sshHost"].string ?? "Unknown")
                    LabeledContent("Local project", value: projectName(peer["projectId"].string))
                    Text("Remote project: \(peer["remoteProjectId"].string ?? "Unknown")").font(.caption).textSelection(.enabled)
                    Text("Remote computer: \(peer["deviceId"].string ?? "Unknown")").font(.caption).textSelection(.enabled)
                    if let checked = peer["lastObservedAt"].string { Text("Last verified: \(checked). Current reachability is unknown until tested.").font(.caption) }
                    else { Text("Connection not tested.").foregroundStyle(.secondary) }
                    if let error = peer["lastError"].string { Text(error).foregroundStyle(.orange) }
                    Button("Test connection") { perform { _ = try await client.request("/peers/settings/test", body: ["peerId": peer["id"].any]); try await load(); message = "Owner identity and project grant verified now." } }
                }
            }
            Section {
                DisclosureGroup("Connect another computer") {
                    TextField("Computer name", text: $label)
                    TextField("Existing SSH host", text: $host)
                    projectPicker("Matching local project", selection: $localProject)
                    SecureField("Private connection code", text: $code)
                    TextField("Remote command", text: $command)
                    Button("Save connection") { perform(secret: true) { try await saveConnection() } }.disabled(code.isEmpty || localProject.isEmpty || label.isEmpty || host.isEmpty)
                    Text("Paste the complete JSON code from the owner. No passwords or SSH keys go here. The code is cleared after saving or leaving this view.").font(.caption)
                }
            }
            Section {
                DisclosureGroup("Allow another computer to use a project here") {
                    TextField("Source computer ID", text: $sourceDevice)
                    projectPicker("Project here", selection: $grantProject)
                    Text("This grant allows work in this project using this computer's native accounts. Share only with the named source computer.").font(.caption)
                    Button("Create project grant") { perform(secret: true) { try await createGrant() } }.disabled(UUID(uuidString: sourceDevice) == nil || grantProject.isEmpty)
                    if !exported.isEmpty { Text(exported).font(.system(.caption, design: .monospaced)).textSelection(.enabled); Button("Hide connection code") { exported = "" } }
                    ForEach(settings["grants"].array ?? [], id: \.selfID) { grant in
                        VStack(alignment: .leading) {
                            Text("\(projectName(grant["projectId"].string)) · \(grant["sourceDeviceId"].string ?? "Unknown source")").font(.caption)
                            if grant["revoked"].bool == true { Text("Revoked").foregroundStyle(.secondary) }
                            else { Button("Revoke project grant", role: .destructive) { perform { _ = try await client.request("/peers/settings/revoke", body: ["grantId": grant["id"].any]); exported = ""; humanExport = ""; try await load() } } }
                        }
                    }
                }
            }
            Section {
                DisclosureGroup("Optional human approval sharing") {
                    Text("Off by default. A separate owner-issued code permits exact human decisions for the mapped project. Connection pairing alone does not enable approvals.").font(.caption)
                    Picker("Saved computer and project", selection: $humanPeer) {
                        Text("Choose a connection").tag("")
                        ForEach(peers, id: \.selfID) { peer in Text((peer["label"].string ?? "Computer") + " · " + projectName(peer["projectId"].string)).tag(peer["id"].string ?? "") }
                    }.onChange(of: humanPeer) { _, _ in humanCode = "" }
                    if (human["connections"].array ?? []).contains(where: { $0["peerId"].string == humanPeer }) {
                        Text("Approval sharing configured. Pending requests still require review.")
                        Button("Remove sharing", role: .destructive) { perform { _ = try await client.request("/peers/settings/human/remove", body: ["peerId": humanPeer]); try await load() } }
                    } else {
                        SecureField("Private approval code", text: $humanCode)
                        Button("Save approval sharing") { perform(secret: true) { try await saveHuman() } }.disabled(humanPeer.isEmpty || humanCode.isEmpty)
                    }
                    ForEach((settings["grants"].array ?? []).filter { $0["revoked"].bool != true }, id: \.selfID) { grant in
                        Button("Create approval code · \(projectName(grant["projectId"].string))") {
                            perform(secret: true) {
                                let scope = generation
                                let value = try await client.request("/peers/settings/human/grant", body: ["grantId": grant["id"].any])
                                guard generation == scope, client.connected else { return }
                                var fields = value.objectValue ?? [:]; fields["humanGrantId"] = fields.removeValue(forKey: "id")
                                humanExport = JSON.object(fields).prettyText; try await load()
                            }
                        }
                    }
                    if !humanExport.isEmpty { Text(humanExport).font(.system(.caption, design: .monospaced)).textSelection(.enabled); Button("Hide approval code") { humanExport = "" } }
                    ForEach(human["grants"].array ?? [], id: \.selfID) { grant in
                        if grant["revoked"].bool != true {
                            Button("Revoke approval sharing · \(projectName(grant["projectId"].string))", role: .destructive) { perform { _ = try await client.request("/peers/settings/human/revoke", body: ["humanGrantId": grant["id"].any]); humanExport = ""; try await load() } }
                        }
                    }
                }
            }
        }.formStyle(.grouped).disabled(working || !client.connected)
        .task(id: client.connected) { if client.connected { perform { try await load() } } }
        .onDisappear { generation += 1; clearSecrets() }
        .onChange(of: client.connected) { _, connected in if !connected { generation += 1; clearSecrets(); settings = .null; human = .null } }
    }
    private func projectName(_ id: String?) -> String { projects.first { $0["id"].string == id }?["name"].string ?? id ?? "Project" }
    private func projectPicker(_ title: String, selection: Binding<String>) -> some View {
        Picker(title, selection: selection) { Text("Choose a project").tag(""); ForEach(projects, id: \.selfID) { project in Text(project["name"].string ?? "Project").tag(project["id"].string ?? "") } }
    }
    private func clearSecrets() { code = ""; humanCode = ""; exported = ""; humanExport = "" }
    private func perform(secret: Bool = false, _ operation: @escaping @MainActor () async throws -> Void) {
        guard !working, client.connected else { return }
        working = true; message = ""
        Task { defer { working = false }; do { try await operation() } catch { message = secret ? "The private code or settings could not be saved. Check the selected computer/project and use a fresh complete code." : error.localizedDescription } }
    }
    private func load() async throws {
        let scope = generation
        let saved = try await client.request("/peers/settings")
        let capabilities = try await client.request("/peers/settings/human")
        guard generation == scope, client.connected else { return }
        settings = saved; human = capabilities; await client.refresh()
    }
    private func parsed(_ text: String) throws -> JSON {
        guard text.utf8.count <= 4096, let data = text.data(using: .utf8), let value = try? JSONDecoder().decode(JSON.self, from: data), value.objectValue != nil else { throw LocalError.message("Invalid private code.") }; return value
    }
    private func saveConnection() async throws {
        let value = try parsed(code)
        guard ["deviceId", "remoteProjectId", "grantId"].allSatisfy({ UUID(uuidString: value[$0].string ?? "") != nil }), NativeRemoteBoundary.digest(value["grantToken"].string) else { throw LocalError.message("Invalid connection code.") }
        var body: [String: Any] = ["label": label, "sshHost": host, "command": command, "projectId": localProject, "deviceId": value["deviceId"].any, "remoteProjectId": value["remoteProjectId"].any, "grantId": value["grantId"].any, "grantToken": value["grantToken"].any]
        if value["nodePath"] != .null { body["nodePath"] = value["nodePath"].any; body["command"] = value["command"].any }
        _ = try await client.request("/peers/settings/save", body: body); code = ""; try await load(); message = "Connection saved. Test it before relying on remote access."
    }
    private func createGrant() async throws {
        exported = ""
        let scope = generation
        let value = try await client.request("/peers/settings/grant", body: ["sourceDeviceId": sourceDevice, "projectId": grantProject])
        guard generation == scope, client.connected else { return }
        var fields: [String: JSON] = ["deviceId": settings["device"]["id"], "remoteProjectId": value["projectId"], "grantId": value["id"], "grantToken": value["token"]]
        for (key, item) in (value["launch"].objectValue ?? settings["launch"].objectValue ?? [:]) { fields[key] = item }
        exported = JSON.object(fields).prettyText; try await load()
    }
    private func saveHuman() async throws {
        let value = try parsed(humanCode)
        guard let peer = peers.first(where: { $0["id"].string == humanPeer }), UUID(uuidString: value["humanGrantId"].string ?? "") != nil, NativeRemoteBoundary.digest(value["token"].string), value["grantId"] == peer["grantId"], value["ownerDeviceId"] == peer["deviceId"], value["projectId"] == peer["remoteProjectId"], value["sourceDeviceId"] == settings["device"]["id"] else { throw LocalError.message("Approval code does not match this mapping.") }
        _ = try await client.request("/peers/settings/human/save", body: ["peerId": humanPeer, "humanGrantId": value["humanGrantId"].any, "token": value["token"].any]); humanCode = ""; try await load(); message = "Approval sharing configured. No request was approved."
    }
}

struct NativeRemoteWorkView: View {
    @ObservedObject var client: AgentKlarClient
    @Binding var selected: String?
    @State private var observed: JSON = .null
    @State private var working = false
    @State private var message = ""
    private var dispatches: [JSON] { (client.snapshot["remoteDispatches"].array ?? []).filter { $0["projectId"].string == client.projectID } }
    private var dispatch: JSON { dispatches.first { $0["id"].string == selected } ?? .null }
    private var current: JSON { observed["id"].string == selected ? observed : dispatch }
    var body: some View {
        HSplitView {
            List(selection: $selected) {
                ForEach(dispatches, id: \.selfID) { item in
                    VStack(alignment: .leading) { Text(item["prompt"].string ?? "Remote task").lineLimit(2); Text("Last known: \(item["lastKnownRun"]["state"].string ?? "Unknown")").font(.caption).foregroundStyle(.secondary) }.tag(item["id"].string ?? "")
                }
            }.frame(minWidth: 220, idealWidth: 280)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let id = current["id"].string {
                        Text(current["prompt"].string ?? "Remote task").font(.title2)
                        Text("Owner: \(owner(current))")
                        Text("Owner run: \(current["ownerRunId"].string ?? "Acceptance not confirmed")").font(.caption).textSelection(.enabled)
                        Text("Connection: \(current["connection"].string ?? "Unknown") · Last known state: \(current["lastKnownRun"]["state"].string ?? "Unknown")")
                        if let time = current["lastObservedAt"].string { Text("Observed: \(time). The owner worker may have changed since then.").font(.caption) }
                        if let error = current["error"].string { Text(error).foregroundStyle(.orange) }
                        HStack {
                            Button("Check owner status") { refreshOwner(id, stop: false) }
                            Button("Request stop", role: .destructive) { refreshOwner(id, stop: true) }.disabled(current["ownerRunId"].string == nil)
                        }.disabled(working || !client.connected)
                        Text("Lost contact does not stop the worker. Full results and event tails are available on the owning computer.").font(.caption).foregroundStyle(.secondary)
                        if !message.isEmpty { Text(message).foregroundStyle(.orange) }
                        if let result = current["lastKnownRun"]["result"].string { Text("Last observed result").font(.headline); Text(result).textSelection(.enabled); if current["lastKnownRun"]["resultTruncated"].bool == true { Text("Result shortened by the service.").font(.caption) } }
                        NativeRemoteApprovalsView(client: client, dispatch: current).id(id)
                    } else { Text("Choose a remote task. No remote work is started by this view.").foregroundStyle(.secondary) }
                }.padding().frame(maxWidth: .infinity, alignment: .leading)
            }.frame(minWidth: 360)
        }.onChange(of: selected) { _, _ in observed = .null; message = "" }
        .onChange(of: client.projectID) { _, _ in selected = nil; observed = .null; message = "" }
    }
    private func owner(_ item: JSON) -> String { (client.snapshot["peers"].array ?? []).first { $0["id"] == item["peerId"] }?["label"].string ?? item["ownerDeviceId"].string ?? "Unknown" }
    private func refreshOwner(_ id: String, stop: Bool) {
        guard !working, client.connected else { return }; working = true; message = ""
        Task { defer { working = false }; do { let value = try await client.request("/runs/\(id)" + (stop ? "/stop" : ""), body: stop ? [:] : nil); if selected == id { observed = value }; await client.refresh() } catch { if selected == id { message = error.localizedDescription } } }
    }
}

// Only the exact one-action forms offered by native adapters are eligible for acceptance.
enum NativeRemoteBoundary {
    static func digest(_ value: String?) -> Bool { value?.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil }
    static func concrete(_ approval: JSON) -> Bool {
        let details = approval["details"]
        if approval["kind"].string == "command" { return !(details["command"].string?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) && details["cwd"].string != nil }
        guard approval["kind"].string == "file" else { return false }
        if let path = details["file_path"].string, path.hasPrefix("/") {
            if details["tool"].string == "Write" { return details["content"].string != nil }
            if details["tool"].string == "Edit" { return details["old_string"].string != nil && details["new_string"].string != nil }
        }
        guard let changes = details["changes"].array, !changes.isEmpty else { return false }
        return changes.allSatisfy { $0["path"].string != nil && $0["diff"].string != nil }
    }
    static func component(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "" }
}

struct NativeRemoteApprovalsView: View {
    @ObservedObject var client: AgentKlarClient
    let dispatch: JSON
    @State private var summaries: [JSON] = []
    @State private var review: JSON = .null
    @State private var pending: JSON = .null
    @State private var receipt: JSON = .null
    @State private var configured = false
    @State private var working = false
    @State private var message = ""
    @State private var confirm = false
    private var id: String { dispatch["id"].string ?? "" }
    private var approval: JSON { review["approval"] }
    private var active: Bool { ["running", "needs_attention"].contains(dispatch["lastKnownRun"]["state"].string ?? "") }
    private var validReview: Bool {
        NativeRemoteBoundary.digest(review["digest"].string) && approval["runId"] == dispatch["ownerRunId"] && summaries.contains { $0["id"] == approval["id"] && $0["digest"] == review["digest"] && $0["available"].bool == true }
    }
    var body: some View {
        GroupBox("Remote human approvals") {
            VStack(alignment: .leading, spacing: 10) {
                Text(configured ? "Sharing is configured. Read the owner request before choosing." : "Native approvals stay on the owner. Configure separate approval sharing in Other computers.").font(.caption)
                if configured {
                    Button("Check approvals") { perform { let value = try await client.request("/remote-approvals/\(id)/list", body: [:]); summaries = value["approvals"].array ?? []; review = .null; receipt = .null; try await loadIntent() } }.disabled(!active || pending != .null)
                }
                if !message.isEmpty { Text(message).foregroundStyle(.orange) }
                if pending != .null {
                    Text("Unconfirmed answer: \(pending["decision"].string ?? "Unknown"). Retry preserves its request ID and exact choice.")
                    Button("Retry same choice") { perform { try await send(pending) } }.disabled(!configured)
                }
                if receipt != .null { Text("\(receipt["state"].string ?? "Receipt"): \(receipt["message"].string ?? "")").foregroundStyle(.secondary) }
                ForEach(summaries, id: \.selfID) { item in
                    VStack(alignment: .leading) {
                        Text(item["title"].string ?? "Native request").font(.headline)
                        if let reason = item["reason"].string { Text(reason).font(.caption) }
                        Button("Review request") { perform { review = try await client.request("/remote-approvals/\(id)/\(NativeRemoteBoundary.component(item["id"].string ?? ""))/read", body: [:]); try await loadIntent() } }.disabled(item["available"].bool != true || pending != .null || !active)
                    }
                }
                if approval != .null {
                    Text(approval["title"].string ?? "Permission request").font(.headline)
                    Text(approval["details"].prettyText).font(.system(.body, design: .monospaced)).textSelection(.enabled)
                    if !NativeRemoteBoundary.concrete(approval) { Text("This request cannot be accepted here. Review it on the owner computer.").foregroundStyle(.orange) }
                    HStack {
                        ForEach((approval["decisions"].array ?? []).compactMap(\.string).filter { ["accept", "decline", "cancel"].contains($0) }, id: \.self) { decision in
                            Button(decision == "accept" ? "Allow once…" : decision.capitalized) {
                                if decision == "accept" { confirm = true } else { answer(decision) }
                            }.disabled(!validReview || !active || pending != .null || (decision == "accept" && !NativeRemoteBoundary.concrete(approval)))
                        }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.disabled(working || !client.connected)
        .confirmationDialog("Allow this exact reviewed action once on the owner computer?", isPresented: $confirm) { Button("Allow once") { answer("accept") }; Button("Cancel", role: .cancel) {} }
        .task(id: id + String(client.connected)) { review = .null; summaries = []; pending = .null; receipt = .null; if client.connected { perform { try await loadIntent() } } }
    }
    private func loadIntent() async throws {
        let value = try await client.request("/peers/settings/human")
        configured = (value["connections"].array ?? []).contains { $0["peerId"] == dispatch["peerId"] }
        let intents = (value["actionIntents"].array ?? []).filter { $0["dispatchId"].string == id }
        if let rejected = intents.first(where: { $0["state"].string == "rejected" && $0["requestId"] == pending["requestId"] }) { pending = .null; review = .null; message = rejected["error"].string ?? "The answer was rejected. Review the owner request again." }
        if let saved = intents.first(where: { $0["state"].string == "pending" }) { pending = saved }
    }
    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !working, client.connected else { return }; working = true; message = ""
        Task { defer { working = false }; do { try await operation() } catch { message = error.localizedDescription; review = .null; summaries = []; try? await loadIntent() } }
    }
    private func answer(_ decision: String) {
        guard validReview, active, pending == .null, configured, decision != "accept" || NativeRemoteBoundary.concrete(approval), let approvalID = approval["id"].string else { return }
        let savedReview = review
        perform {
            let current = try await client.request("/remote-approvals/\(id)/\(NativeRemoteBoundary.component(approvalID))/read", body: [:])
            guard current["approval"] == savedReview["approval"], current["digest"] == savedReview["digest"], current["approval"]["runId"] == dispatch["ownerRunId"], (current["approval"]["decisions"].array ?? []).contains(.string(decision)) else { throw LocalError.message("The owner request changed. Review it again before answering.") }
            pending = .object(["approvalId": .string(approvalID), "requestId": .string(UUID().uuidString), "expectedDigest": current["digest"], "decision": .string(decision)])
            try await send(pending)
        }
    }
    private func send(_ answer: JSON) async throws {
        guard let approvalID = answer["approvalId"].string, NativeRemoteBoundary.digest(answer["expectedDigest"].string), let decision = answer["decision"].string, ["accept", "decline", "cancel"].contains(decision), UUID(uuidString: answer["requestId"].string ?? "") != nil else { throw LocalError.message("The saved answer is unsupported. Review on the owner computer.") }
        receipt = try await client.request("/remote-approvals/\(id)/\(NativeRemoteBoundary.component(approvalID))/answer", body: ["requestId": answer["requestId"].any, "expectedDigest": answer["expectedDigest"].any, "decision": decision])
        pending = .null; review = .null; summaries = []; await client.refresh()
    }
}
