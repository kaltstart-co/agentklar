import SwiftUI
import Foundation

/// The same local API accepts a local run ID or a remote dispatch ID.
struct NativeChangesView: View {
    @ObservedObject var client: AgentKlarClient
    let sourceID: String
    @State private var destination = ""
    @State private var preview: JSON = .null
    @State private var receipt: JSON = .null
    @State private var saved: [JSON] = []
    @State private var working = false
    @State private var message = ""
    @State private var reviewed = false
    @State private var confirm = false
    @State private var uncertain = false
    @State private var generation = 0
    private var packet: JSON { preview["packet"] }
    private var previewID: String? { preview["id"].string }
    private var sourceActive: Bool {
        if let run = client.runs.first(where: { $0["id"].string == sourceID }) { return ["running", "needs_attention"].contains(run["state"].string ?? "") }
        return (client.snapshot["remoteDispatches"].array ?? []).contains { $0["id"].string == sourceID && ["running", "needs_attention"].contains($0["lastKnownRun"]["state"].string ?? "") }
    }
    private var fullPatch: Bool { NativeChangeBoundary.fullPreview(preview) }
    private var applied: Bool { receipt != .null }

    var body: some View {
        DisclosureGroup("Copy Git changes to a new local worktree") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Prepare a saved patch from finished work. Review it, then apply to a separate local checkout. This does not merge, commit or mark the work reviewed.").font(.caption).foregroundStyle(.secondary)
                Picker("Local destination project", selection: $destination) {
                    Text("Choose a project").tag("")
                    ForEach(client.projects, id: \.selfID) { project in Text(project["name"].string ?? "Project").tag(project["id"].string ?? "") }
                }.disabled(working || applied || uncertain)
                HStack {
                    Button("Prepare and preview") { prepare() }.disabled(destination.isEmpty || sourceActive || applied || uncertain)
                    Button("Find saved handoffs") { findSaved() }
                }
                if sourceActive { Text("Wait for the source worker to stop before preparing a new patch. The service also checks for possibly surviving workers.").font(.caption).foregroundStyle(.orange) }
                if !message.isEmpty { Text(message).foregroundStyle(.orange).textSelection(.enabled) }
                ForEach(saved, id: \.selfID) { item in
                    Button("Open \(item["applied"] == .null ? "prepared" : "applied") handoff · \(projectName(item["projectId"].string)) · \(item["createdAt"].string ?? "Unknown time")") {
                        if let id = item["id"].string { openSaved(id) }
                    }
                }
                if preview != .null {
                    previewDetails
                    if packet["patch"].string == nil || !fullPatch {
                        Button("Read full saved patch") { if let id = previewID { openSaved(id) } }
                    }
                    if let patch = packet["patch"].string {
                        Text("Patch").font(.headline)
                        ScrollView([.vertical, .horizontal]) { Text(patch).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(minHeight: 100, maxHeight: 300)
                    }
                    if !fullPatch { Text("The complete saved patch and file list must be loaded before applying.").font(.caption).foregroundStyle(.orange) }
                    if preview["application"] != .null && !applied {
                        LabeledContent("Saved application", value: preview["application"]["state"].string ?? "Unknown")
                        if let path = preview["application"]["workspace"]["path"].string { Text("Owned destination: \(path)").font(.caption).textSelection(.enabled) }
                        if let error = preview["application"]["error"].string { Text(error).foregroundStyle(.orange) }
                        Text("Inspect any interrupted destination before retrying this same handoff. The service verifies its worktree, base and staged tree; changed files cause refusal.").font(.caption)
                    }
                    if uncertain {
                        Text("The apply result is unconfirmed. Read this saved handoff to check its receipt or interrupted intent before deciding again.").foregroundStyle(.orange)
                        Button("Check saved apply result") { if let id = previewID { openSaved(id) } }
                    }
                    if !applied {
                        Toggle("I reviewed this complete patch, source and destination", isOn: $reviewed).disabled(!fullPatch || uncertain)
                        Button(preview["application"] == .null ? "Apply to a new local worktree…" : "Retry this reviewed handoff…") { confirm = true }
                            .disabled(!fullPatch || !reviewed || uncertain)
                    }
                }
                if applied { receiptDetails }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(.top, 8)
        }.disabled(working || !client.connected || client.busy)
        .confirmationDialog("Apply the exact reviewed patch to a separate local worktree?", isPresented: $confirm) {
            Button("Apply reviewed patch") { applyReviewed() }
            Button("Cancel", role: .cancel) {}
        } message: { Text("Destination: \(projectName(preview["projectId"].string)). Original checkouts are preserved. Review and test the imported changes before committing.") }
        .task(id: sourceID + ":" + client.projectID + ":" + String(client.connected)) { reset(); destination = client.projectID }
        .onChange(of: destination) { _, _ in if !working && !uncertain { preview = .null; receipt = .null; reviewed = false; message = "" } }
        .onDisappear { generation += 1 }
    }
    private var previewDetails: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Destination: \(projectName(preview["projectId"].string))").font(.headline)
            Text("Source: \(sourceName(packet["sourceDeviceId"].string))")
            LabeledContent("Source run", value: packet["sourceRunId"].string ?? "Unknown")
            LabeledContent("Base commit", value: packet["baseCommit"].string ?? "Unknown")
            LabeledContent("Source HEAD", value: packet["headCommit"].string ?? "Unknown")
            LabeledContent("Patch digest", value: packet["digest"].string ?? "Unknown")
            Text("Prepared: \(preview["createdAt"].string ?? "Unknown")").font(.caption)
            ForEach(packet["files"].array ?? [], id: \.self) { file in Text("\(file["path"].string ?? "Unknown path") · +\(Int(file["added"].number ?? 0)) / −\(Int(file["removed"].number ?? 0))").font(.caption) }
            if packet["filesTruncated"].bool == true { Text("The file list is shortened. Read the full saved patch.").foregroundStyle(.orange) }
            if !(packet["ignoredPaths"].array ?? []).isEmpty || packet["ignoredTruncated"].bool == true {
                Text("Ignored files are excluded from the patch.").foregroundStyle(.orange)
                ForEach(packet["ignoredPaths"].array ?? [], id: \.self) { path in Text(path.string ?? "").font(.caption) }
                if packet["ignoredTruncated"].bool == true { Text("More ignored paths exist. Check the source checkout.").font(.caption) }
            }
            Text("The destination needs this exact base commit. Unsupported or conflicting changes are refused by the service.").font(.caption).foregroundStyle(.secondary)
        }.textSelection(.enabled)
    }
    private var receiptDetails: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Changes applied in a separate worktree").font(.headline)
            LabeledContent("Folder", value: receipt["workspace"]["path"].string ?? "Unknown")
            LabeledContent("Branch", value: receipt["workspace"]["branch"].string ?? "Unknown")
            LabeledContent("Applied", value: receipt["appliedAt"].string ?? "Unknown")
            LabeledContent("Receipt digest", value: receipt["digest"].string ?? "Unknown")
            Text(receipt["message"].string ?? "Changes are staged for review. Inspect git status and git diff --cached, then test before committing. Your original folder was preserved.").font(.caption)
            ForEach(receipt["continuations"].array ?? [], id: \.self) { command in
                Text("Open a fresh \(command["harness"].string ?? "native") session").font(.headline)
                Text(command["display"].string ?? "").font(.system(.caption, design: .monospaced)).textSelection(.enabled)
            }
            Text("These commands are guidance. The app does not execute them or resume an existing native conversation.").font(.caption).foregroundStyle(.secondary)
        }.textSelection(.enabled)
    }
    private func projectName(_ id: String?) -> String { client.projects.first { $0["id"].string == id }?["name"].string ?? id ?? "Unknown project" }
    private func sourceName(_ id: String?) -> String {
        if client.snapshot["device"]["id"].string == id { return client.snapshot["device"]["label"].string ?? "This computer" }
        return (client.snapshot["peers"].array ?? []).first { $0["deviceId"].string == id }?["label"].string ?? id ?? "Unknown computer"
    }
    private func reset() { generation += 1; preview = .null; receipt = .null; saved = []; reviewed = false; uncertain = false; message = ""; confirm = false }
    private func perform(_ operation: @escaping @MainActor (Int) async throws -> Void) {
        guard !working, client.connected, UUID(uuidString: sourceID) != nil else { return }
        let scope = generation; working = true; message = ""
        Task {
            defer { working = false }
            do { try await operation(scope) }
            catch { if scope == generation { message = error.localizedDescription } }
        }
    }
    private func adopt(_ value: JSON) throws {
        guard NativeChangeBoundary.identity(value), belongsToSource(value["packet"]) else { throw LocalError.message("Saved handoff identity does not match this source. No apply was requested.") }
        preview = value; reviewed = false; confirm = false
        if value["applied"] != .null {
            guard NativeChangeBoundary.receipt(value["applied"], preview: value) else { throw LocalError.message("The saved apply receipt could not be verified. Inspect the destination manually.") }
            receipt = value["applied"]
        } else { receipt = .null }
        uncertain = false
    }
    private func belongsToSource(_ value: JSON) -> Bool {
        if let remote = (client.snapshot["remoteDispatches"].array ?? []).first(where: { $0["id"].string == sourceID }) { return value["sourceRunId"] == remote["ownerRunId"] && value["sourceDeviceId"] == remote["ownerDeviceId"] }
        return value["sourceRunId"].string == sourceID && value["sourceDeviceId"] == client.snapshot["device"]["id"]
    }
    private func prepare() {
        guard !sourceActive, !uncertain, !applied else { return }
        let target = destination
        perform { scope in
            let value = try await client.request("/runs/\(sourceID)/changes/prepare", body: ["projectId": target, "includePatch": true])
            guard scope == generation else { return }
            guard value["projectId"].string == target else { throw LocalError.message("The handoff destination changed. Review a fresh preview.") }
            try adopt(value)
        }
    }
    private func findSaved() {
        perform { scope in
            let value = try await client.request("/runs/\(sourceID)/changes")
            guard scope == generation else { return }
            saved = value["handoffs"].array ?? []
            if let reason = value["message"].string { message = reason }
            else if saved.isEmpty { message = "No saved handoffs were reported for this source." }
        }
    }
    private func openSaved(_ id: String) {
        guard UUID(uuidString: id) != nil else { return }
        perform { scope in
            let value = try await client.request("/changes/\(id)?includePatch=true&compact=false")
            guard scope == generation else { return }
            try adopt(value)
        }
    }
    private func applyReviewed() {
        guard reviewed, fullPatch, !applied, !uncertain, let id = previewID else { return }
        let reviewedPreview = preview
        perform { scope in
            let latest = try await client.request("/changes/\(id)?includePatch=true&compact=false")
            guard scope == generation else { return }
            guard NativeChangeBoundary.fullPreview(latest), latest["id"] == reviewedPreview["id"], latest["projectId"] == reviewedPreview["projectId"], latest["packet"] == reviewedPreview["packet"], belongsToSource(latest["packet"]) else { reviewed = false; throw LocalError.message("The saved patch or destination differs from your review. Read and review it again.") }
            if latest["applied"] != .null { try adopt(latest); return }
            // A lost response cannot prove failure. Keep this durable preview ID for recovery.
            uncertain = true; reviewed = false
            let result = try await client.request("/changes/\(id)/apply", body: ["expectedDigest": reviewedPreview["packet"]["digest"].any, "expectedBaseCommit": reviewedPreview["packet"]["baseCommit"].any])
            guard scope == generation else { return }
            guard NativeChangeBoundary.receipt(result, preview: reviewedPreview) else { throw LocalError.message("Apply returned an unverified receipt. Check the saved handoff before continuing.") }
            receipt = result; uncertain = false; await client.refresh()
        }
    }
}

// Client checks are display/admission checks; the service owns Git and folder validation.
enum NativeChangeBoundary {
    static func hash(_ value: String?, length: String) -> Bool { value?.range(of: "^[0-9a-f]{" + length + "}$", options: .regularExpression) != nil }
    static func identity(_ value: JSON) -> Bool {
        UUID(uuidString: value["id"].string ?? "") != nil && UUID(uuidString: value["projectId"].string ?? "") != nil
            && UUID(uuidString: value["packet"]["sourceRunId"].string ?? "") != nil && UUID(uuidString: value["packet"]["sourceDeviceId"].string ?? "") != nil
            && hash(value["packet"]["digest"].string, length: "64") && hash(value["packet"]["baseCommit"].string, length: "40,64")
    }
    static func fullPreview(_ value: JSON) -> Bool {
        let packet = value["packet"]
        guard identity(value), let patch = packet["patch"].string, patch.utf8.count <= 96_000, !patch.contains("\0"), let files = packet["files"].array, !files.isEmpty, files.count <= 100 else { return false }
        return packet["filesTruncated"].bool != true && packet["patchTruncated"].bool != true && packet["patchNextOffset"] == .null && (packet["patchOffset"].number ?? 0) == 0
    }
    static func receipt(_ value: JSON, preview: JSON) -> Bool {
        value["previewId"] == preview["id"] && value["digest"] == preview["packet"]["digest"] && value["workspace"]["kind"].string == "worktree"
            && value["workspace"]["verified"].bool == true && value["workspace"]["baseCommit"] == preview["packet"]["baseCommit"]
            && value["workspace"]["path"].string?.hasPrefix("/") == true && !(value["workspace"]["branch"].string ?? "").isEmpty && value["appliedAt"].string != nil
    }
}
