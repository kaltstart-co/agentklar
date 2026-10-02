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
            NativeDetailButton("Native inventory") { inventorySection }.buttonStyle(.plain).foregroundStyle(.tint)
            if working { ProgressView("Reading or changing extensions…").controlSize(.small) }
            if !notice.isEmpty { Text(notice).foregroundStyle(.secondary) }
            if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
        }
        .font(NativeStyle.body).controlSize(.regular).frame(maxWidth: 800, alignment: .leading).frame(maxWidth: .infinity, alignment: .leading)
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
            HStack {
                Text("Skills").font(NativeStyle.heading)
                Spacer()
                Button("Refresh", systemImage: "arrow.clockwise") { Task { await refresh() } }
                    .accessibilityLabel("Refresh skills and plugin status")
            }
            HStack(spacing: 16) {
                Picker("Scope", selection: $skillScope) {
                    Text("Project").tag("project")
                    Text("Personal").tag("personal")
                }.pickerStyle(.menu)
                Picker("Folder", selection: $harness) { Text("Codex / shared").tag("codex"); Text("Claude Code").tag("claude") }
                    .pickerStyle(.menu).accessibilityLabel("Native skill folder")
            }
            Text(skillScope == "project" ? "For this project. Your native harness decides what loads." : "For your native home. Other profiles may use different folders.")
                .font(NativeStyle.caption).foregroundStyle(.secondary)
            if !skillAvailable { Text("Choose a project, or use Personal scope.") }
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    TextField("GitHub source", text: $source, prompt: Text("owner/repo#ref")).textFieldStyle(.roundedBorder)
                    TextField("Exact skill name", text: $skillName, prompt: Text("lowercase-skill-name")).textFieldStyle(.roundedBorder)
                }
                HStack {
                    Button("AgentKlar workflow") { source = "kaltstart-co/agentklar#v0.1.0-beta.26"; skillName = "agentklar-workflow" }
                        .buttonStyle(.plain).foregroundStyle(.tint).accessibilityLabel("Use AgentKlar workflow skill")
                    Button("Preview skill") { Task { await skillAction("preview", body: ["harness": harness, "source": source.trimmingCharacters(in: .whitespacesAndNewlines), "name": skillName.trimmingCharacters(in: .whitespacesAndNewlines)]) } }.disabled(source.isEmpty || skillName.isEmpty)
                }
            }.disabled(!skillAvailable)
            if skillPreview["id"].string != nil { skillReview }
            ForEach(skills, id: \.self) { row in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(row["name"].string ?? "Skill").font(NativeStyle.heading)
                        Spacer()
                        let folder = row["harness"].string == "claude" ? "Claude Code" : row["harness"].string == "codex" ? "Codex" : "Unknown folder"
                        Text("\(folder) · \(row["state"].string?.capitalized ?? "Unknown state")")
                            .font(NativeStyle.caption).foregroundStyle(.secondary)
                    }
                    if let text = row["message"].string, !text.isEmpty { Text(text).font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    HStack {
                        if row["state"].string == "installed", let id = row["id"].string {
                            Button("Check update") { Task { await skillAction("preview-update", body: ["installId": id]) } }
                            Button("Remove…", role: .destructive) { pendingRemoval = row; confirmsRemoval = true }
                        }
                        NativeDetailButton("Details") {
                            Text(row["path"].string ?? "Path unavailable").textSelection(.enabled)
                            if row["state"].string == "external" { Text("External skill. AgentKlar does not own or remove it.") }
                            Text("The native harness decides which skills to load. Installation does not confirm session activation.")
                                .foregroundStyle(.secondary)
                            code(row)
                        }.buttonStyle(.plain).foregroundStyle(.tint)
                    }
                }.padding(.vertical, 6)
                Divider()
            }
            if skills.isEmpty { Text("No skills loaded.").font(NativeStyle.caption).foregroundStyle(.secondary) }
        }
    }

    private var skillReview: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Review \(skillPreview["name"].string ?? "skill")").font(NativeStyle.heading)
            NativeDetailButton("Review files and source") {
                Text("Install path").font(NativeStyle.heading)
                Text(skillPreview["path"].string ?? "Path unavailable").textSelection(.enabled)
                Text("Source: \(skillPreview["source"].string ?? "Unknown")").textSelection(.enabled)
                if let current = skillPreview["currentText"].string {
                    Text("Currently installed SKILL.md").font(NativeStyle.heading)
                    Text(current).font(.system(size: 14, design: .monospaced)).textSelection(.enabled)
                }
                Text("Reviewed SKILL.md").font(NativeStyle.heading)
                Text(skillPreview["text"].string ?? "Content unavailable").font(.system(size: 14, design: .monospaced)).textSelection(.enabled)
                Text("File hashes and source pin").font(NativeStyle.heading)
                code(skillPreview)
            }.buttonStyle(.plain).foregroundStyle(.tint)
            Text("Start a new native session to load the installed skill.").font(NativeStyle.caption).foregroundStyle(.secondary)
            if skillPreview["hasChanges"].bool == false { Text("Already up to date.").foregroundStyle(.secondary) }
            else if skillPreview["hasChanges"].bool == true, let id = skillPreview["id"].string {
                Button(skillPreview["updateInstallId"].string == nil ? "Install reviewed skill" : "Apply reviewed skill update") {
                    let operation = skillPreview["updateInstallId"].string == nil ? "install" : "update"
                    Task { await skillAction(operation, body: ["previewId": id]) }
                }.buttonStyle(.borderedProminent)
            }
        }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }

    private var pluginsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Workflow plugin").font(NativeStyle.heading)
            Text("Claude Code · This project · Reload plugins or start a new session after installing.")
                .font(NativeStyle.caption).foregroundStyle(.secondary)
            if client.projectID.isEmpty { Text("Choose a project to manage its plugin.") }
            if plugins != .null, plugins["available"].bool != true {
                Label("Plugin commands unavailable", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                if let message = plugins["message"].string { Text(message).font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
            HStack {
                Button("Preview plugin") { Task { await pluginAction("preview") } }.disabled(client.projectID.isEmpty || plugins["available"].bool != true)
                if plugins != .null {
                    NativeDetailButton("Plugin details") {
                        Text("A versioned native Claude plugin with the AgentKlar workflow skill. Individual skills stay separate.")
                        if let message = plugins["message"].string { Text(message).foregroundStyle(.secondary) }
                        code(plugins)
                    }.buttonStyle(.plain).foregroundStyle(.tint)
                }
            }
            if pluginPreview["id"].string != nil {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(pluginPreview["name"].string ?? "Plugin") · \(pluginPreview["version"].string ?? "Unknown version")").font(NativeStyle.heading)
                    Text(pluginPreview["scope"].string ?? "Unknown scope").font(NativeStyle.caption).foregroundStyle(.secondary)
                    let counts = pluginPreview["capabilities"]
                    Text("\((counts["skills"].array ?? []).count) skills · \(Int(counts["agents"].number ?? 0)) agents · \(Int(counts["hooks"].number ?? 0)) hooks · \(Int(counts["mcpServers"].number ?? 0)) MCP servers")
                    Text("Native permissions still apply.").font(NativeStyle.caption).foregroundStyle(.secondary)
                    NativeDetailButton("Review plugin") { code(pluginPreview) }.buttonStyle(.plain).foregroundStyle(.tint)
                    Button("Install reviewed native plugin") { Task { await pluginAction("apply") } }.buttonStyle(.borderedProminent)
                }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
            }
            ForEach((plugins["changes"].array ?? []).filter { $0["state"].string != "undone" }, id: \.self) { receipt in
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(receipt["version"].string ?? "Unknown version").font(NativeStyle.heading)
                        Spacer()
                        Text(plugins["available"].bool != true ? "Unavailable" : receipt["installed"].bool == true ? "Installed" : "Not installed")
                            .font(NativeStyle.caption).foregroundStyle(.secondary)
                    }
                    if receipt["state"].string != "applied" {
                        Label(receipt["state"].string?.capitalized ?? "Unknown state", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                        if let text = receipt["message"].string { Text(text).font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
                    }
                    if receipt["recognized"].bool != true { Text("Native recognition unverified.").font(NativeStyle.caption).foregroundStyle(.secondary) }
                    HStack {
                        if receipt["canUndo"].bool == true, let id = receipt["id"].string { Button("Undo unchanged plugin") { Task { await pluginAction("undo", changeID: id) } } }
                        NativeDetailButton("Details") {
                            Text(receipt["recognized"].bool == true ? "Components recognized at install. Current session activation unknown." : "Native recognition unverified.")
                            if let text = receipt["message"].string { Text(text).foregroundStyle(.secondary) }
                            code(receipt)
                        }.buttonStyle(.plain).foregroundStyle(.tint)
                    }
                }.padding(.vertical, 6)
                Divider()
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
