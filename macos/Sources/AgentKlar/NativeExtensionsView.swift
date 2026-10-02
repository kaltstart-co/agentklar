import SwiftUI

struct NativeExtensionsView: View {
    @ObservedObject var client: AgentKlarClient
    @State private var skillScope = "project"
    @State private var harness = "codex"
    @State private var source = ""
    @State private var skillName = ""
    @State private var draftOwner = ""
    @State private var skills: [JSON] = []
    @State private var skillPreview: JSON = .null
    @State private var plugins: JSON = .null
    @State private var pluginPreview: JSON = .null
    @State private var inventory: JSON = .null
    @State private var pendingRemoval: JSON = .null
    @State private var confirmsRemoval = false
    @State private var working = false
    @State private var failure = ""
    @State private var notice = ""
    private var owner: String { client.projectID + ":" + skillScope + ":" + harness }
    private var scope: String { owner + ":" + String(client.connected) }
    private var projectBase: String { "/projects/\(client.projectID)" }
    private var skillBase: String { skillScope == "personal" ? "/skills" : projectBase + "/skills" }
    private var skillAvailable: Bool { skillScope == "personal" || !client.projectID.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            skillsSection
            Divider()
            pluginsSection
            Divider()
            NativeDetailButton("Native config and extension metadata") { inventorySection }
            if working { ProgressView("Reading or changing extensions…").controlSize(.small) }
            if !notice.isEmpty { Text(notice).foregroundStyle(.secondary) }
            if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
        }
        .disabled(working || client.busy || !client.connected)
        .onChange(of: source) { _, _ in skillPreview = .null }
        .onChange(of: skillName) { _, _ in skillPreview = .null }
        .confirmationDialog("Remove this unchanged managed skill?", isPresented: $confirmsRemoval, titleVisibility: .visible) {
            Button("Remove managed skill", role: .destructive) {
                if let id = pendingRemoval["id"].string { Task { await skillAction("remove", body: ["installId": id]) } }
            }
            Button("Cancel", role: .cancel) { pendingRemoval = .null }
        } message: { Text("\(pendingRemoval["name"].string ?? "Skill")\n\(pendingRemoval["path"].string ?? "")\nRemoval is allowed only while the managed files remain unchanged.") }
        .task(id: scope) {
            let captured = scope
            if draftOwner != owner {
                draftOwner = owner
                source = ""; skillName = ""
            }
            skills = []; plugins = .null; inventory = .null; skillPreview = .null; pluginPreview = .null
            pendingRemoval = .null; confirmsRemoval = false; failure = ""; notice = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if !Task.isCancelled, captured == scope, client.connected { await refresh() }
        }
    }

    private var skillsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Skills").font(NativeStyle.heading)
            Picker("Install scope", selection: $skillScope) {
                Text("Project").tag("project")
                Text("Personal").tag("personal")
            }
            Picker("Native skill folder", selection: $harness) { Text("Codex / shared skills").tag("codex"); Text("Claude Code").tag("claude") }
            Text(skillScope == "project" ? "Project skills stay in this project. Shared skills can also be read by compatible native harnesses." : "Personal skills use the service's native home. Other native profiles may use different folders.").font(NativeStyle.caption).foregroundStyle(.secondary)
            Text("The native harness decides which skills to load. Installation does not confirm session activation.").font(NativeStyle.caption).foregroundStyle(.secondary)
            if !skillAvailable { Text("Choose a project, or use Personal scope.") }
            Button("Refresh skills and plugin status", systemImage: "arrow.clockwise") { Task { await refresh() } }
            Group {
                TextField("GitHub source", text: $source, prompt: Text("owner/repo#ref"))
                TextField("Exact skill name", text: $skillName, prompt: Text("lowercase-skill-name"))
                HStack {
                    Button("Use AgentKlar workflow skill") { source = "kaltstart-co/agentklar#v0.1.0-beta.26"; skillName = "agentklar-workflow" }
                    Button("Preview skill") { Task { await skillAction("preview", body: ["harness": harness, "source": source.trimmingCharacters(in: .whitespacesAndNewlines), "name": skillName.trimmingCharacters(in: .whitespacesAndNewlines)]) } }.disabled(source.isEmpty || skillName.isEmpty)
                }
            }.disabled(!skillAvailable)
            if skillPreview["id"].string != nil { skillReview }
            ForEach(skills, id: \.self) { row in
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(row["name"].string ?? "Skill") · \(row["harness"].string ?? "Unknown") · \(row["state"].string ?? "Unknown state")").font(NativeStyle.heading)
                    Text(row["path"].string ?? "Path unavailable").font(NativeStyle.caption).textSelection(.enabled)
                    if let text = row["message"].string { Text(text).font(NativeStyle.caption).foregroundStyle(.secondary) }
                    if row["state"].string == "installed", let id = row["id"].string {
                        HStack {
                            Button("Preview upstream update") { Task { await skillAction("preview-update", body: ["installId": id]) } }
                            Button("Remove…", role: .destructive) { pendingRemoval = row; confirmsRemoval = true }
                        }
                    } else if row["state"].string == "external" {
                        Text("External skill. AgentKlar does not own or remove it.").font(NativeStyle.caption).foregroundStyle(.secondary)
                    }
                    NativeDetailButton("Skill record") { code(row) }
                }.padding(.vertical, 4)
            }
            if skills.isEmpty { Text("No skill records loaded.").foregroundStyle(.secondary) }
        }
    }

    private var skillReview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Review \(skillPreview["name"].string ?? "skill")").font(NativeStyle.heading)
            Text(skillPreview["path"].string ?? "Path unavailable").textSelection(.enabled)
            Text("Source: \(skillPreview["source"].string ?? "Unknown")").textSelection(.enabled)
            NativeDetailButton("Review skill files and source") {
                if let current = skillPreview["currentText"].string {
                    Text("Currently installed SKILL.md").font(NativeStyle.heading)
                    Text(current).font(.system(size: 14, design: .monospaced)).textSelection(.enabled)
                }
                Text("Reviewed SKILL.md").font(NativeStyle.heading)
                Text(skillPreview["text"].string ?? "Content unavailable").font(.system(size: 14, design: .monospaced)).textSelection(.enabled)
                Text("File hashes and source pin").font(NativeStyle.heading)
                code(skillPreview)
            }
            if skillPreview["hasChanges"].bool == false { Text("Already up to date.").foregroundStyle(.secondary) }
            else if skillPreview["hasChanges"].bool == true, let id = skillPreview["id"].string {
                Button(skillPreview["updateInstallId"].string == nil ? "Install reviewed skill" : "Apply reviewed skill update") {
                    let operation = skillPreview["updateInstallId"].string == nil ? "install" : "update"
                    Task { await skillAction(operation, body: ["previewId": id]) }
                }
            }
        }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }

    private var pluginsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Claude workflow plugin").font(NativeStyle.heading)
            Text("A versioned native Claude plugin with the AgentKlar workflow skill. Local project scope. Individual skills stay separate.").foregroundStyle(.secondary)
            if client.projectID.isEmpty { Text("Choose a project to manage its plugin.") }
            if let message = plugins["message"].string { Text(message).font(NativeStyle.caption).foregroundStyle(.secondary) }
            if plugins != .null { Label(plugins["available"].bool == true ? "Native plugin commands available" : "Native plugin commands unavailable", systemImage: plugins["available"].bool == true ? "checkmark.circle" : "questionmark.circle") }
            Button("Preview workflow plugin") { Task { await pluginAction("preview") } }.disabled(client.projectID.isEmpty || plugins["available"].bool != true)
            if pluginPreview["id"].string != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(pluginPreview["name"].string ?? "Plugin") · \(pluginPreview["version"].string ?? "Unknown version")").font(NativeStyle.heading)
                    Text(pluginPreview["scope"].string ?? "Unknown scope")
                    let counts = pluginPreview["capabilities"]
                    Text("\((counts["skills"].array ?? []).count) skills · \(Int(counts["agents"].number ?? 0)) agents · \(Int(counts["hooks"].number ?? 0)) hooks · \(Int(counts["mcpServers"].number ?? 0)) MCP servers")
                    Text(pluginPreview["message"].string ?? "").foregroundStyle(.secondary)
                    NativeDetailButton("Reviewed commands, manifest, content hashes and pin") { code(pluginPreview) }
                    Button("Install reviewed native plugin") { Task { await pluginAction("apply") } }
                }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
            ForEach((plugins["changes"].array ?? []).filter { $0["state"].string != "undone" }, id: \.self) { receipt in
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(receipt["version"].string ?? "Unknown version") · \(receipt["state"].string ?? "Unknown state")").font(NativeStyle.heading)
                    Text(plugins["available"].bool != true ? "Install state unavailable" : receipt["installed"].bool == true ? "Installed" : "Not installed")
                    Text(receipt["recognized"].bool == true ? "Components recognized at install. Current session activation unknown." : "Native recognition unverified.").font(NativeStyle.caption).foregroundStyle(.secondary)
                    if let text = receipt["message"].string { Text(text).font(NativeStyle.caption).foregroundStyle(.secondary) }
                    if receipt["canUndo"].bool == true, let id = receipt["id"].string { Button("Undo unchanged plugin") { Task { await pluginAction("undo", changeID: id) } } }
                    NativeDetailButton("Owned plugin change receipt") { code(receipt) }
                }.padding(.vertical, 4)
            }
        }
    }

    private var inventorySection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("File presence and bounded native metadata. Cached packages and manifests do not confirm enabled or loaded extensions.").font(NativeStyle.caption).foregroundStyle(.secondary)
            Button("Refresh native inventory") { Task { await loadInventory() } }.disabled(client.projectID.isEmpty)
            if let date = inventory["checkedAt"].string { Text("Checked: \(date)").font(NativeStyle.caption) }
            if inventory["truncated"].bool == true { Label("Partial inventory. Some records exceeded the display limit.", systemImage: "ellipsis.circle").foregroundStyle(.orange) }
            ForEach(inventory["harnesses"].array ?? [], id: \.self) { entry in
                GroupBox(entry["harness"].string ?? "Native harness") {
                    ForEach(entry["sources"].array ?? [], id: \.self) { row in
                        VStack(alignment: .leading) {
                            Text("\(row["scope"].string ?? "Unknown scope") · \(row["kind"].string ?? "Config") · \(row["status"].string ?? "Unknown")")
                            if let path = row["path"].string { Text(path).font(NativeStyle.caption).textSelection(.enabled) }
                            if let text = row["message"].string { Text(text).font(NativeStyle.caption).foregroundStyle(.secondary) }
                        }
                    }
                    ForEach(entry["extensions"].array ?? [], id: \.self) { row in
                        Text("\(row["name"].string ?? "Extension") · \(row["version"].string ?? "Version unknown") · \(row["evidence"].string ?? "Evidence unknown") · activation unknown").font(NativeStyle.caption).textSelection(.enabled)
                    }
                    if entry["extensionsTruncated"].bool == true { Text("Extension list is partial.").foregroundStyle(.orange) }
                    code(entry)
                }
            }
        }.padding(.top, 8)
    }

    private func code(_ value: JSON) -> some View { Text(value.prettyText).font(.system(size: 12, design: .monospaced)).textSelection(.enabled) }
    private func refresh() async {
        guard !working, client.connected else { return }
        let captured = scope, skillsPath = skillBase, projectPath = projectBase, hasProject = !client.projectID.isEmpty, hasSkills = skillAvailable
        working = true; failure = ""; skillPreview = .null; pluginPreview = .null
        defer { working = false }
        if hasSkills {
            do { let next = try await client.request(skillsPath); if captured == scope, client.connected { skills = next["skills"].array ?? [] } }
            catch { if captured == scope, client.connected { skills = []; failure = error.localizedDescription } }
        }
        if hasProject, captured == scope, client.connected, !Task.isCancelled {
            do { let next = try await client.request(projectPath + "/plugins"); if captured == scope, client.connected { plugins = next } }
            catch { if captured == scope, client.connected { plugins = .null; failure = error.localizedDescription } }
        }
    }
    private func skillAction(_ operation: String, body: [String: Any]) async {
        guard !working, !client.busy, client.connected, skillAvailable else { return }
        let captured = scope, path = skillBase
        working = true; failure = ""; notice = ""
        defer { working = false }
        do {
            let next = try await client.request(path + "/" + operation, body: body)
            if captured == scope, client.connected {
                if operation == "preview" || operation == "preview-update" { skillPreview = next }
                else { skillPreview = .null; pendingRemoval = .null; notice = next["unchanged"].bool == true ? "Already up to date." : "Managed skill changed. Start a new native session to load the change." }
            }
        } catch { if captured == scope, client.connected { failure = error.localizedDescription; skillPreview = .null } }
        if !operation.hasPrefix("preview"), captured == scope, client.connected {
            do { let next = try await client.request(path); if captured == scope, client.connected { skills = next["skills"].array ?? [] } }
            catch { if captured == scope, client.connected { skills = []; failure = error.localizedDescription } }
        }
    }
    private func pluginAction(_ operation: String, changeID: String? = nil) async {
        guard !working, !client.busy, client.connected, !client.projectID.isEmpty else { return }
        let captured = scope, path = projectBase + "/plugins"
        var body: [String: Any] = [:]
        if operation == "apply" { guard let id = pluginPreview["id"].string else { return }; body = ["previewId": id] }
        if operation == "undo" { guard let changeID else { return }; body = ["changeId": changeID] }
        working = true; failure = ""; notice = ""
        defer { working = false }
        do {
            let next = try await client.request(path + "/" + operation, body: body)
            if captured == scope, client.connected {
                if operation == "preview" { pluginPreview = next }
                else { pluginPreview = .null; notice = "Managed plugin changed. Reload native plugins or start a new native session." }
            }
        } catch { if captured == scope, client.connected { failure = error.localizedDescription; pluginPreview = .null } }
        // A failed native command may still leave an owned, retryable cleanup receipt.
        if operation != "preview", captured == scope, client.connected {
            do { let next = try await client.request(path); if captured == scope, client.connected { plugins = next } }
            catch { if captured == scope, client.connected { plugins = .null; failure = error.localizedDescription } }
        }
    }
    private func loadInventory() async {
        guard !working, client.connected, !client.projectID.isEmpty else { return }
        let captured = scope, path = projectBase + "/native-inventory"
        working = true; failure = ""
        defer { working = false }
        do { let next = try await client.request(path); if captured == scope, client.connected { inventory = next } }
        catch { if captured == scope, client.connected { inventory = .null; failure = error.localizedDescription } }
    }
}
