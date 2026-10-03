import SwiftUI
import Foundation

struct NativeDevicesView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var settings: JSON = .null
    @State private var human: JSON = .null
    @State private var working = false
    @State private var message = ""
    @State private var failed = false
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
    @State private var connecting = false
    @State private var remoteSetup = false
    private var peers: [JSON] { settings["peers"].array ?? [] }
    private var projects: [JSON] { settings["projects"].array ?? [] }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 16) { deviceHeading; Spacer(); deviceActions }
                    VStack(alignment: .leading, spacing: 12) { deviceHeading; deviceActions }
                }
                localComputer
                Divider()
                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("Connected computers").font(NativeStyle.heading)
                        Spacer()
                        Text("\(peers.count)").font(NativeStyle.caption).foregroundStyle(.secondary)
                    }.padding(.bottom, 8)
                    if peers.isEmpty {
                        Text("Connect a computer to use its agents and view its work here.")
                            .foregroundStyle(.secondary).padding(.vertical, 20)
                    }
                    ForEach(peers, id: \.selfID) { peer in
                        peerRow(peer)
                        Divider()
                    }
                }
                HStack(spacing: 20) {
                    Button("Remote project setup") { remoteSetup = true }
                    NativeDetailButton("Share a project") { shareForm }
                    NativeDetailButton("Approval sharing") { approvalForm }
                }.buttonStyle(.plain).foregroundStyle(.tint)
                operationFeedback
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.font(NativeStyle.body).controlSize(.regular).disabled(working || !client.connected)
        .sheet(isPresented: $remoteSetup) { NativeDetailPage(title: "Remote project setup") { NativeRemoteSetupView(client: client) } }
        .sheet(isPresented: $connecting) {
            NativeDetailPage(title: "Connect a computer") { connectForm }
        }
        .task(id: client.connected) { if client.connected { perform { try await load() } } }
        .onDisappear { generation += 1; clearSecrets() }
        .onChange(of: client.connected) { _, connected in if !connected { generation += 1; clearSecrets(); settings = .null; human = .null } }
    }

    private var deviceHeading: some View {
        NativeSectionTitle(title: "Computers", subtitle: "Use agents on this Mac and your other computers.")
    }
    private var deviceActions: some View {
        HStack(spacing: 12) {
            Button { perform { try await load() } } label: {
                Image(systemName: "arrow.clockwise").frame(width: 28, height: 28).contentShape(Rectangle())
            }.buttonStyle(.plain).foregroundStyle(.secondary)
                .accessibilityLabel("Refresh saved computers").help("Refresh saved computers")
            Button("Connect computer", systemImage: "plus") { message = ""; failed = false; connecting = true }.buttonStyle(.borderedProminent)
        }.fixedSize()
    }
    private var localComputer: some View {
        HStack(spacing: 14) {
            computerIcon("laptopcomputer")
            VStack(alignment: .leading, spacing: 5) {
                Text(settings["device"]["label"].string ?? "This Mac").font(NativeStyle.heading)
                    .lineLimit(2).textSelection(.enabled)
                Text("This Mac").font(NativeStyle.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            NativeDetailButton("This Mac details") {
                LabeledContent("Computer", value: settings["device"]["label"].string ?? "Unknown")
                LabeledContent("Computer ID", value: settings["device"]["id"].string ?? "Unknown").textSelection(.enabled)
                Text("Use this ID when allowing this Mac to use a project on another computer.")
                    .font(NativeStyle.caption).foregroundStyle(.secondary)
            }.buttonStyle(.plain).foregroundStyle(.tint)
        }.padding(.vertical, 8)
    }
    private func peerRow(_ peer: JSON) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { peerSummary(peer); Spacer(minLength: 12); peerActions(peer) }
            VStack(alignment: .leading, spacing: 12) {
                peerSummary(peer)
                peerActions(peer).padding(.leading, 54)
            }
        }.padding(.vertical, 16)
    }
    private func peerSummary(_ peer: JSON) -> some View {
        HStack(alignment: .top, spacing: 14) {
            computerIcon("desktopcomputer")
            VStack(alignment: .leading, spacing: 5) {
                Text(peer["label"].string ?? "Computer").font(NativeStyle.heading).lineLimit(2)
                Text(projectName(peer["projectId"].string)).font(NativeStyle.caption).foregroundStyle(.secondary).lineLimit(2)
                Label(checkSummary(peer), systemImage: peer["lastError"].string == nil ? "clock" : "exclamationmark.triangle")
                    .font(NativeStyle.caption).foregroundStyle(peer["lastError"].string == nil ? Color.secondary : Color.orange)
            }
        }
    }
    private func peerActions(_ peer: JSON) -> some View {
        HStack(spacing: 16) {
            NativeDetailButton("Connection details") { peerDetails(peer) }.buttonStyle(.plain).foregroundStyle(.tint)
            Button("Test connection") {
                perform {
                    // Reload the recorded error too, so a failed check stays visible after the operation.
                    do {
                        _ = try await client.request("/peers/settings/test", body: ["peerId": peer["id"].any])
                    } catch {
                        try? await load()
                        throw error
                    }
                    try await load(); message = "Owner identity and project grant verified now."
                }
            }.buttonStyle(.bordered)
        }.fixedSize()
    }
    private func peerDetails(_ peer: JSON) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            NativeSectionTitle(title: peer["label"].string ?? "Computer", subtitle: "Saving a connection does not start work. Test it to check access now.")
            LabeledContent("SSH host", value: peer["sshHost"].string ?? "Unknown")
            LabeledContent("Local project", value: projectName(peer["projectId"].string))
            LabeledContent("Remote project ID", value: peer["remoteProjectId"].string ?? "Unknown")
            LabeledContent("Remote computer ID", value: peer["deviceId"].string ?? "Unknown")
            LabeledContent("Remote command", value: peer["command"].string ?? "Unknown")
            if let checked = peer["lastObservedAt"].string {
                LabeledContent("Last successful check", value: checked)
            }
            Text("Current reachability is unknown until tested. An earlier successful check does not confirm access now.")
                .font(NativeStyle.caption).foregroundStyle(.secondary)
            if let error = peer["lastError"].string { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
        }.textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
    private func computerIcon(_ symbol: String) -> some View {
        Image(systemName: symbol).font(.system(size: 20, weight: .regular)).foregroundStyle(.secondary)
            .frame(width: 40, height: 40).background(.quaternary, in: RoundedRectangle(cornerRadius: 10))
            .accessibilityHidden(true)
    }
    private func checkSummary(_ peer: JSON) -> String {
        if peer["lastError"].string != nil { return "Last check failed" }
        guard let text = peer["lastObservedAt"].string else { return "Not tested" }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { return "Last check date unknown" }
        let relative = RelativeDateTimeFormatter(); relative.unitsStyle = .full
        return "Last check " + relative.localizedString(for: date, relativeTo: Date())
    }

    private var connectForm: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Install AgentKlar on both computers and register both project folders. Use an existing SSH connection and a project code from the other computer.").foregroundStyle(.secondary)
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 16) {
                GridRow { Text("Name"); TextField("Computer name", text: $label) }
                GridRow { Text("SSH host"); TextField("Existing SSH host", text: $host) }
                GridRow { Text("Local project"); projectPicker("Local project", selection: $localProject).labelsHidden() }
                GridRow { Text("Connection code"); SecureField("Private connection code", text: $code) }
                GridRow { Text("Remote command"); TextField("Remote command", text: $command) }
            }
            Button("Save connection") { perform(secret: true) { try await saveConnection() } }.buttonStyle(.borderedProminent).disabled(code.isEmpty || localProject.isEmpty || label.isEmpty || host.isEmpty)
            Text("Paste the complete JSON code from the owner. No passwords or SSH keys go here. The code is cleared after saving or leaving this view.").font(NativeStyle.caption)
            operationFeedback
        }.textFieldStyle(.roundedBorder).foregroundStyle(.primary).disabled(working || !client.connected)
            .onAppear { message = ""; failed = false }
            .onDisappear { generation += 1; clearSecrets() }
    }
    private var shareForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField("Source computer ID", text: $sourceDevice)
            projectPicker("Project here", selection: $grantProject)
            Text("This grant allows work in this project using this computer's native accounts. Share only with the named source computer.").font(NativeStyle.caption)
            Button("Create project grant") { perform(secret: true) { try await createGrant() } }.buttonStyle(.borderedProminent).disabled(UUID(uuidString: sourceDevice) == nil || grantProject.isEmpty)
            if !exported.isEmpty { Text(exported).font(.system(.caption, design: .monospaced)).textSelection(.enabled); Button("Hide connection code") { exported = "" } }
            ForEach(settings["grants"].array ?? [], id: \.selfID) { grant in
                VStack(alignment: .leading) {
                    Text("\(projectName(grant["projectId"].string)) · \(grant["sourceDeviceId"].string ?? "Unknown source")").font(NativeStyle.caption)
                    if grant["revoked"].bool == true { Text("Revoked").foregroundStyle(.secondary) }
                    else { Button("Revoke project grant", role: .destructive) { perform { _ = try await client.request("/peers/settings/revoke", body: ["grantId": grant["id"].any]); exported = ""; humanExport = ""; try await load() } } }
                }
            }
            operationFeedback
        }.textFieldStyle(.roundedBorder).foregroundStyle(.primary).disabled(working || !client.connected)
            .onAppear { message = ""; failed = false }
            .onDisappear { generation += 1; clearSecrets() }
    }
    private var approvalForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Off by default. A separate owner-issued code permits exact human decisions for the mapped project. Connection pairing alone does not enable approvals.").font(NativeStyle.caption)
            Picker("Saved computer and project", selection: $humanPeer) {
                Text("Choose a connection").tag("")
                ForEach(peers, id: \.selfID) { peer in Text((peer["label"].string ?? "Computer") + " · " + projectName(peer["projectId"].string)).tag(peer["id"].string ?? "") }
            }.onChange(of: humanPeer) { _, _ in humanCode = "" }
            if (human["connections"].array ?? []).contains(where: { $0["peerId"].string == humanPeer }) {
                Text("Approval sharing configured. Pending requests still require review.")
                Button("Remove sharing", role: .destructive) { perform { _ = try await client.request("/peers/settings/human/remove", body: ["peerId": humanPeer]); try await load() } }
            } else {
                SecureField("Private approval code", text: $humanCode)
                Button("Save approval sharing") { perform(secret: true) { try await saveHuman() } }.buttonStyle(.borderedProminent).disabled(humanPeer.isEmpty || humanCode.isEmpty)
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
            operationFeedback
        }.textFieldStyle(.roundedBorder).foregroundStyle(.primary).disabled(working || !client.connected)
            .onAppear { message = ""; failed = false }
            .onDisappear { generation += 1; clearSecrets() }
    }
    @ViewBuilder private var operationFeedback: some View {
        if working { ProgressView("Reading computer settings…").controlSize(.small) }
        if !message.isEmpty {
            Label(message, systemImage: failed ? "exclamationmark.triangle" : "checkmark.circle")
                .font(NativeStyle.caption).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(failed ? Color.red : Color.secondary).textSelection(.enabled)
        }
    }
    private func projectName(_ id: String?) -> String { projects.first { $0["id"].string == id }?["name"].string ?? id ?? "Project" }
    private func projectPicker(_ title: String, selection: Binding<String>) -> some View {
        Picker(title, selection: selection) { Text("Choose a project").tag(""); ForEach(projects, id: \.selfID) { project in Text(project["name"].string ?? "Project").tag(project["id"].string ?? "") } }
    }
    private func clearSecrets() { code = ""; humanCode = ""; exported = ""; humanExport = "" }
    private func perform(secret: Bool = false, _ operation: @escaping @MainActor () async throws -> Void) {
        guard !working, client.connected else { return }
        working = true; message = ""; failed = false
        Task { defer { working = false }; do { try await operation() } catch { failed = true; message = secret ? "The private code or settings could not be saved. Check the selected computer/project and use a fresh complete code." : error.localizedDescription } }
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
    let onFollowUp: (JSON) -> Void
    @State private var observed: JSON = .null
    @State private var working = false
    @State private var message = ""
    private var dispatches: [JSON] { (client.snapshot["remoteDispatches"].array ?? []).filter { $0["projectId"].string == client.projectID } }
    private var dispatch: JSON { dispatches.first { $0["id"].string == selected } ?? .null }
    private var current: JSON { observed["id"].string == selected ? observed : dispatch }
    var body: some View {
        Group {
            if dispatches.isEmpty { emptyRemoteWork }
            else { remoteTasks }
        }.font(NativeStyle.body).controlSize(.regular).labelStyle(.titleAndIcon)
        .onChange(of: selected) { _, _ in observed = .null; message = "" }
        .onChange(of: client.projectID) { _, _ in selected = nil; observed = .null; message = "" }
    }
    private var emptyRemoteWork: some View {
        let peers = (client.snapshot["peers"].array ?? []).filter { $0["projectId"].string == client.projectID }
        return NativeEmptyState("No remote tasks", systemImage: "desktopcomputer", description: peers.isEmpty ? "Connect a computer in Settings → Devices to send work there." : "Work sent to your connected computers will appear here. Choose a computer when starting a task.") {
            Button("New task", systemImage: "plus") { onFollowUp(.null) }
                .buttonStyle(.borderedProminent).disabled(!client.connected || client.projectID.isEmpty)
        }
    }
    private var remoteTasks: some View {
        NativeWorkLayout {
            List(selection: $selected) {
                ForEach(dispatches, id: \.selfID) { item in
                    HStack(alignment: .top, spacing: 10) {
                        NativeHarnessIcon(harness: item["harness"].string ?? item["lastKnownRun"]["harness"].string ?? "", size: 24)
                        VStack(alignment: .leading, spacing: 5) {
                            Text(item["prompt"].string ?? "Remote task").lineLimit(2)
                            Text("Last known: \(item["lastKnownRun"]["state"].string ?? "Unknown")").font(NativeStyle.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 6).tag(item["id"].string ?? "")
                }
            }
        } detail: {
            if current["id"].string == nil {
                NativeEmptyState("Select a remote task", systemImage: "desktopcomputer", description: "View work and results from your connected computers.") {}
            } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let id = current["id"].string {
                        Text(NativeTaskTitle.text(current["prompt"].string)).font(NativeStyle.title)
                        NativeDetailButton("Task instructions") { Text(current["prompt"].string ?? "Remote task").font(NativeStyle.document).lineSpacing(4).textSelection(.enabled) }.id("remote-prompt:" + id)
                        Text("Owner: \(owner(current))")
                        Text("Owner run: \(current["ownerRunId"].string ?? "Acceptance not confirmed")").font(NativeStyle.caption).textSelection(.enabled)
                        Text("Connection: \(current["connection"].string ?? "Unknown") · Last known state: \(current["lastKnownRun"]["state"].string ?? "Unknown")")
                        if let time = current["lastObservedAt"].string { Text("Observed: \(time). The owner worker may have changed since then.").font(NativeStyle.caption) }
                        if let error = current["error"].string { Text(error).foregroundStyle(.orange) }
                        HStack {
                            Button("Check owner status") { refreshOwner(id, stop: false) }
                            Button("Request stop", role: .destructive) { refreshOwner(id, stop: true) }.disabled(current["ownerRunId"].string == nil)
                        }.disabled(working || !client.connected)
                        Text("Lost contact does not stop the worker. Full results and event tails are available on the owning computer.").font(NativeStyle.caption).foregroundStyle(.secondary)
                        if !message.isEmpty { Text(message).foregroundStyle(.orange) }
                        if let result = current["lastKnownRun"]["result"].string { Text("Last observed result").font(NativeStyle.heading); Text(result).textSelection(.enabled); if current["lastKnownRun"]["resultTruncated"].bool == true { Text("Result shortened by the service.").font(NativeStyle.caption) } }
                        NativeRemoteApprovalsView(client: client, dispatch: current).id(id)
                        if current["lastKnownRun"]["state"].string == "completed" {
                            Button(current["lastKnownRun"]["followUp"]["kind"].string == "review" ? "Fix findings on owner" : "Review work on owner", systemImage: "arrow.triangle.branch") {
                                var source = current["lastKnownRun"].objectValue ?? [:]
                                source["id"] = current["id"]; source["peerId"] = current["peerId"]
                                onFollowUp(.object(source))
                            }.disabled(working || !client.connected)
                        }
                        NativeDetailButton("Move changes to another project") { NativeChangesView(client: client, sourceID: id).id(id) }.id("remote-changes:" + id)
                    }
                }.frame(maxWidth: 760, alignment: .leading).padding(NativeStyle.pagePadding).frame(maxWidth: .infinity)
            }
            }
        }
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
                Text(configured ? "Sharing is configured. Read the owner request before choosing." : "Native approvals stay on the owner. Configure separate approval sharing in Other computers.").font(NativeStyle.caption)
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
                        Text(item["title"].string ?? "Native request").font(NativeStyle.heading)
                        if let reason = item["reason"].string { Text(reason).font(NativeStyle.caption) }
                        Button("Review request") { perform { review = try await client.request("/remote-approvals/\(id)/\(NativeRemoteBoundary.component(item["id"].string ?? ""))/read", body: [:]); try await loadIntent() } }.disabled(item["available"].bool != true || pending != .null || !active)
                    }
                }
                if approval != .null {
                    Text(approval["title"].string ?? "Permission request").font(NativeStyle.heading)
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
