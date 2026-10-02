import SwiftUI
import AppKit

/// Human review of saved coordination packets. Acceptance belongs to the native MCP client.
struct NativeProjectHandoffView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var control: JSON = .null
    @State private var packet: JSON = .null
    @State private var history: JSON = .null
    @State private var currentContextRevision: Double?
    @State private var mode = "advisory"
    @State private var review = ""
    @State private var reviewedControl: JSON = .null
    @State private var reviewedMode = ""
    @State private var offset = 0
    @State private var working = false
    @State private var failure = ""
    @State private var notice = ""
    private var scope: String { client.projectID + ":" + String(client.connected) }
    private var base: String { "/projects/\(client.projectID)/control" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Switch main harness").font(.headline)
            Text("Keep saved project context and work references when another native harness takes over. Existing workers stay on their computers. Native sessions and permissions stay with their harness.").foregroundStyle(.secondary)
            Text("Prepare uses saved context. Save any context draft first.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Refresh handoff status", systemImage: "arrow.clockwise") { Task { await refreshStatus() } }
                Button("Prepare handoff") { Task { await prepare() } }
                Button("Saved handoffs") { Task { await loadHistory(0) } }
            }
            if history != .null { historySection }
            if packet["id"].string != nil { packetSection }
            if control != .null { controlSection }
            if client.projectID.isEmpty { Text("Choose a project to prepare a handoff.") }
            if working { ProgressView("Reading or changing project coordination…").controlSize(.small) }
            if !notice.isEmpty { Text(notice).foregroundStyle(.secondary) }
            if !failure.isEmpty { Label(failure + " Refresh before trying again.", systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
        }
        .disabled(working || client.busy || !client.connected || client.projectID.isEmpty)
        .onChange(of: mode) { _, _ in review = ""; reviewedControl = .null }
        .task(id: scope) {
            control = .null; packet = .null; history = .null; currentContextRevision = nil
            mode = "advisory"; review = ""; reviewedControl = .null; reviewedMode = ""
            offset = 0; failure = ""; notice = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if !Task.isCancelled { await refreshStatus() }
        }
    }

    private var historySection: some View {
        DisclosureGroup("Saved handoff history") {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(history["packets"].array ?? [], id: \.self) { row in
                    if let id = row["id"].string {
                        Button("\(row["createdAt"].string ?? "Date unknown") · \(row["receipt"] == .null ? "Prepared" : "Accepted")") { Task { await loadPacket(id) } }
                    }
                }
                if (history["packets"].array ?? []).isEmpty { Text("No saved handoffs.").foregroundStyle(.secondary) }
                if let next = history["nextOffset"].number { Button("Older handoffs") { Task { await loadHistory(Int(next)) } } }
                if offset > 0 { Text("Showing an older page.").font(.caption).foregroundStyle(.secondary) }
            }.padding(.top, 6)
        }
    }

    private var packetSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Saved handoff · \(packet["createdAt"].string ?? "Date unknown")").font(.headline)
            Label(packet["receipt"] == .null ? "Prepared snapshot" : "Accepted by receiving harness", systemImage: packet["receipt"] == .null ? "doc.text" : "checkmark.circle")
            if packet["receipt"] == .null {
                if let saved = packet["control"]["revision"].number, let current = control["revision"].number, saved != current {
                    Label("Control changed. Prepare a fresh handoff before acceptance.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                }
                if let saved = packet["context"]["revision"].number, let currentContextRevision, saved != currentContextRevision {
                    Label("Saved context changed. Prepare a fresh handoff before acceptance.", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                }
            } else {
                Text("\(packet["receipt"]["lead"]["clientName"].string ?? "Unknown MCP client") accepted at \(packet["receipt"]["acceptedAt"].string ?? "an unknown time"). This is a saved receipt. Refresh status for the current lead.").font(.caption).foregroundStyle(.secondary)
            }
            Text("Saved context revision \(revisionText(packet["context"]["revision"])). \(revisionText(packet["work"]["totalLocal"])) local and \(revisionText(packet["work"]["totalRemote"])) remote work references. States were observed when prepared.").font(.caption).foregroundStyle(.secondary)
            DisclosureGroup("Saved project context") {
                VStack(alignment: .leading, spacing: 6) {
                    contextText("Brief", key: "brief")
                    contextText("Memory", key: "memory")
                    contextText("Next steps", key: "handoff")
                }.padding(.top, 6)
            }
            DisclosureGroup("Work references") { workReferences }
            DisclosureGroup("Receiving harness instructions") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Open your normal native harness with AgentKlar MCP. Read this packet and projects_list for current roles and cost preference. Review the context and work, then explicitly accept using a stable UUID. A stale packet needs a new prepare.").foregroundStyle(.secondary)
                    Text("Only the receiving harness accepts through its MCP bridge. This app does not claim its identity.").font(.caption).foregroundStyle(.secondary)
                    if let instructions = receivingInstructions {
                        Text(instructions).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        Button("Copy receiving harness pointer", systemImage: "doc.on.doc") {
                            NSPasteboard.general.clearContents()
                            if NSPasteboard.general.setString(instructions, forType: .string) { notice = "Receiving harness instructions copied." }
                            else { failure = "Could not copy. Use the displayed instructions." }
                        }
                    } else { Text("Exact packet identifiers or revisions are unavailable. Read a complete packet before acceptance.").foregroundStyle(.orange) }
                }.padding(.top, 6)
            }
            DisclosureGroup("Exact digest, revisions and saved packet") { code(packet) }
        }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }

    private var workReferences: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(packet["work"]["local"].array ?? [], id: \.self) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(row["harness"].string ?? "Native") task · \(row["state"].string ?? "Unknown state")")
                    Text(row["id"].string ?? "Task ID unavailable").font(.caption).textSelection(.enabled)
                    if let id = row["id"].string { Button("View task", systemImage: "arrow.up.forward.square") { client.requestedRunID = id } }
                    Text("Observed: \(row["updatedAt"].string ?? "Unknown")").font(.caption).foregroundStyle(.secondary)
                    if let path = row["workspace"]["path"].string { Text(path + (row["workspace"]["pathTruncated"].bool == true ? " (shortened; read task for full path)" : "")).font(.caption).textSelection(.enabled) }
                    if row["followUp"] != .null { code(row["followUp"]) }
                }
            }
            ForEach(packet["work"]["remote"].array ?? [], id: \.self) { row in
                VStack(alignment: .leading, spacing: 4) {
                    Text("Remote task · \(row["state"].string ?? "Owner state unknown") · \(row["connection"].string ?? "Connection unknown")")
                    Text("Task \(row["id"].string ?? "unknown") · owner \(row["ownerDeviceId"].string ?? "unknown")").font(.caption).textSelection(.enabled)
                    if let id = row["id"].string { Button("View remote task", systemImage: "arrow.up.forward.square") { client.requestedRunID = id } }
                    if let date = row["lastObservedAt"].string { Text("Observed: \(date)").font(.caption).foregroundStyle(.secondary) }
                }
            }
            if (packet["work"]["totalLocal"].number ?? 0) > Double((packet["work"]["local"].array ?? []).count) || (packet["work"]["totalRemote"].number ?? 0) > Double((packet["work"]["remote"].array ?? []).count) {
                Text("Showing up to ten references of each kind. Read project history for the remaining work.").font(.caption).foregroundStyle(.secondary)
            }
            Text("Read these references in Work or through the native MCP tools.").font(.caption).foregroundStyle(.secondary)
            code(packet["work"]["pointers"])
        }.padding(.top, 6)
    }

    private var controlSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(control["mode"].string == "coordinated" ? "Coordinated control" : "Advisory lead").font(.headline)
            Text(control["lead"] == .null ? "No lead connected." : "Current lead: \(control["lead"]["clientName"].string ?? "Unknown MCP client"). Client names are reported by the harness.").foregroundStyle(.secondary)
            DisclosureGroup("Project control setting") {
                VStack(alignment: .leading, spacing: 8) {
                    Picker("Control mode", selection: $mode) { Text("Advisory (default)").tag("advisory"); Text("Coordinated").tag("coordinated") }
                    Text("Coordinated control limits MCP task starts, worker stops and shared context changes to the current lead. Trusted human actions remain available. It does not control direct file edits or native permissions.").font(.caption).foregroundStyle(.secondary)
                    Button("Review setting change") { reviewedControl = control; reviewedMode = mode; review = "mode" }.disabled(mode == control["mode"].string || control["revision"].number == nil)
                    if review == "mode" {
                        Text("Change this project to \(reviewedMode) control at revision \(revisionText(reviewedControl["revision"]))? Existing workers keep running.").foregroundStyle(.orange)
                        HStack { Button("Save reviewed setting") { Task { await saveMode() } }; Button("Cancel") { clearReview() } }
                    }
                }.padding(.top, 6)
            }
            DisclosureGroup("Recover a lost lead") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Release the observed lead so a native harness can claim coordination again. Existing workers continue. This does not approve native requests.").font(.caption).foregroundStyle(.secondary)
                    Button("Review recovery") { Task { await reviewRecovery() } }.disabled(control["lead"] == .null)
                    if review == "recover" {
                        Text("Release \(reviewedControl["lead"]["clientName"].string ?? "the observed lead") at revision \(revisionText(reviewedControl["revision"]))?").foregroundStyle(.orange)
                        DisclosureGroup("Exact observed claim") { code(reviewedControl) }
                        HStack { Button("Release reviewed lead", role: .destructive) { Task { await recover() } }; Button("Cancel") { clearReview() } }
                    }
                }.padding(.top, 6)
            }
            DisclosureGroup("Current control metadata") { code(control) }
        }
    }

    private var receivingInstructions: String? {
        guard let project = packet["projectId"].string, project == client.projectID, let id = packet["id"].string,
              let digest = packet["digest"].string, let context = packet["context"]["revision"].number,
              let control = packet["control"]["revision"].number else { return nil }
        return "Read projects_list for current roles and cost preference.\nproject_handoff({action:\"read\",projectId:\"\(project)\",packetId:\"\(id)\"})\nAfter reviewing saved context and work, the receiving native harness can explicitly accept:\nproject_handoff({action:\"accept\",projectId:\"\(project)\",packetId:\"\(id)\",requestId:\"YOUR_STABLE_UUID\",expectedDigest:\"\(digest)\",expectedContextRevision:\(Int(context)),expectedControlRevision:\(Int(control))})"
    }
    private func contextText(_ title: String, key: String) -> some View { VStack(alignment: .leading) { Text(title).font(.headline); Text(packet["context"][key].string.flatMap { $0.isEmpty ? nil : $0 } ?? "No saved text.").textSelection(.enabled) } }
    private func code(_ value: JSON) -> some View { Text(value.prettyText).font(.system(.caption, design: .monospaced)).textSelection(.enabled) }
    private func revisionText(_ value: JSON) -> String { value.number.map { String(Int($0)) } ?? "Unknown" }
    private func clearReview() { review = ""; reviewedControl = .null; reviewedMode = "" }
    private func act(_ action: (String, String) async throws -> Void) async {
        guard !working, !client.busy, client.connected, !client.projectID.isEmpty else { return }
        let captured = scope, path = base
        working = true; failure = ""; notice = ""
        defer { working = false }
        do { try await action(captured, path) }
        catch { if captured == scope { failure = error.localizedDescription; clearReview() } }
    }
    private func status(_ captured: String, _ path: String) async throws {
        let next = try await client.request(path)
        if captured == scope { control = next; mode = next["mode"].string ?? "advisory" }
    }
    private func refreshStatus() async {
        await act { captured, path in
            clearReview(); try await status(captured, path)
            guard captured == scope else { return }
            let context = try await client.request("/projects/\(client.projectID)/context")
            if captured == scope { currentContextRevision = context["revision"].number }
        }
    }
    private func prepare() async {
        await act { captured, path in
            clearReview()
            let next = try await client.request(path + "/prepare", body: [:])
            if captured == scope { packet = next; control = next["control"]; mode = control["mode"].string ?? "advisory"; currentContextRevision = next["context"]["revision"].number }
        }
    }
    private func loadHistory(_ nextOffset: Int) async {
        await act { captured, path in
            let next = try await client.request(path + "/packets?offset=\(nextOffset)&limit=10")
            if captured == scope { history = next; offset = nextOffset }
        }
    }
    private func loadPacket(_ id: String) async {
        await act { captured, path in
            let next = try await client.request(path + "/packets/" + id)
            guard captured == scope else { return }
            packet = next; clearReview()
            try await status(captured, path)
            guard captured == scope else { return }
            let context = try await client.request("/projects/\(client.projectID)/context")
            if captured == scope { currentContextRevision = context["revision"].number }
        }
    }
    private func saveMode() async {
        guard review == "mode", let revision = reviewedControl["revision"].number, ["advisory", "coordinated"].contains(reviewedMode) else { return }
        let body: [String: Any] = ["mode": reviewedMode, "expectedRevision": Int(revision)]
        await act { captured, path in
            let next = try await client.request(path, body: body, method: "PUT")
            if captured == scope { clearReview(); control = next; mode = next["mode"].string ?? "advisory"; notice = "Project control setting saved." }
        }
    }
    private func reviewRecovery() async {
        await act { captured, path in
            clearReview(); try await status(captured, path)
            guard captured == scope else { return }
            if control["lead"]["claimId"].string != nil { reviewedControl = control; review = "recover" }
            else { notice = "No lead remains. Your native harness can claim coordination." }
        }
    }
    private func recover() async {
        guard review == "recover", let revision = reviewedControl["revision"].number, let claim = reviewedControl["lead"]["claimId"].string else { return }
        let body: [String: Any] = ["expectedRevision": Int(revision), "observedClaimId": claim]
        await act { captured, path in
            let next = try await client.request(path + "/recover", body: body)
            if captured == scope { clearReview(); control = next; mode = next["mode"].string ?? "advisory"; notice = "Lead released. The receiving native harness can now claim coordination." }
        }
    }
}
