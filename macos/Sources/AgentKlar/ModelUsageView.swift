import SwiftUI

struct ModelUsageView: View {
    @ObservedObject var client: AgentKlarClient
    let section: String
    var active = true
    @State private var catalog: JSON = .null
    @State private var computerID = ""
    @State private var catalogScope: LoadScope?
    @State private var loadID: UUID?
    @State private var working = false
    @State private var failure = ""
    @State private var search = ""
    @State private var harnessFilter = ""
    @State private var selectedModel: CatalogModel?
    @State private var selectedAllowance: CatalogAllowance?
    @State private var showingBenchmarks = false
    private struct CatalogModel: Identifiable {
        let id: String
        let entry: JSON
        let model: JSON
        var harness: String { entry["harness"].string ?? "" }
    }
    private struct CatalogAllowance: Identifiable {
        let id: String
        let entry: JSON
    }
    private struct LoadScope: Hashable {
        let projectID: String
        let connected: Bool
        let owner: JSON
        let computerID: String
        let peer: JSON
    }
    private var projectPeers: [JSON] {
        (client.snapshot["peers"].array ?? []).filter { $0["projectId"].string == client.projectID }
    }
    private var selectedPeer: JSON { projectPeers.first { $0["id"].string == computerID } ?? .null }
    private var scope: LoadScope {
        LoadScope(projectID: client.projectID, connected: client.connected, owner: client.snapshot["device"], computerID: computerID, peer: selectedPeer)
    }
    private var computerName: String { computerID.isEmpty ? "This Mac" : (selectedPeer["label"].string ?? "Saved computer") }
    private var visibleCatalog: JSON { catalogScope == scope ? catalog : .null }
    private var harnessEntries: [JSON] { visibleCatalog["harnesses"].array ?? [] }
    private var modelRows: [CatalogModel] {
        harnessEntries.flatMap { entry in
            (entry["models"].array ?? []).enumerated().map { index, model in
                CatalogModel(id: (entry["harness"].string ?? "") + ":" + (model["id"].string ?? "") + ":" + String(index), entry: entry, model: model)
            }
        }.filter { row in
            (harnessFilter.isEmpty || row.harness == harnessFilter) &&
            (search.isEmpty || ((row.model["name"].string ?? "") + " " + (row.model["id"].string ?? "")).localizedCaseInsensitiveContains(search))
        }
    }
    @State private var benchmarks: JSON = .null
    @State private var benchmarkBusy = false
    @State private var benchmarkFailure = ""
    private var projectRuns: [JSON] { client.runs.filter { $0["projectId"].string == client.projectID } }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                NativePageHeader(title: section, subtitle: section == "Models" ? "Explore models from your native harnesses." : "Task usage and native account allowance.") {
                    if active { refreshActions.controlSize(.regular).labelStyle(.titleAndIcon) }
                }
                computerPicker
                if section == "Models" {
                    catalogControls
                    metadataStatus
                    modelList
                    Divider()
                    nativeSources
                    benchmarkSummary
                } else {
                    metadataStatus
                    if computerID.isEmpty { usageSection }
                    else { Text("Task totals are available for This Mac. Allowance below is from \(computerName).").font(NativeStyle.caption).foregroundStyle(.secondary) }
                    NativeSectionTitle(title: "Account allowance", subtitle: computerName)
                    ForEach(harnessEntries, id: \.self) { entry in
                        allowanceRow(entry)
                        Divider()
                    }
                    if harnessEntries.isEmpty { Text("Refresh usage to read native allowance.").foregroundStyle(.secondary) }
                }
            }.font(NativeStyle.body).frame(maxWidth: NativeStyle.contentWidth, alignment: .leading)
                .padding(NativeStyle.pagePadding).frame(maxWidth: .infinity, alignment: .top)
        }
        .sheet(item: $selectedModel) { row in modelInspector(row) }
        .sheet(isPresented: $showingBenchmarks) { benchmarkInspector }
        .sheet(item: $selectedAllowance) { row in
            NativeDetailPage(title: "\(providerName(row.id)) allowance") {
                Text(computerName).font(NativeStyle.caption).foregroundStyle(.secondary)
                quota(row.entry["quota"])
            }
        }

        .onChange(of: computerID) { _, _ in selectedModel = nil; selectedAllowance = nil; showingBenchmarks = false }
        .task(id: scope) {
            catalog = .null; catalogScope = nil; failure = ""; selectedModel = nil; selectedAllowance = nil; showingBenchmarks = false
            loadID = nil; working = false
            if !computerID.isEmpty, selectedPeer == .null { computerID = ""; return }
            if !Task.isCancelled { await load(refresh: false) }
            if !Task.isCancelled { await loadBenchmarks(refresh: false) }
        }
    }

    private var computerPicker: some View {
        HStack(spacing: 12) {
            Picker("Computer", selection: $computerID) {
                Text("This Mac").tag("")
                ForEach(projectPeers, id: \.self) { peer in
                    Text(peer["label"].string ?? "Saved computer").tag(peer["id"].string ?? "")
                }
            }.pickerStyle(.menu).accessibilityLabel("Computer for models and account allowance")
            Spacer()
        }
    }

    @ViewBuilder private var metadataStatus: some View {
        if working { ProgressView("Reading native metadata from \(computerName)…") }
        if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        if let checked = visibleCatalog["checkedAt"].string {
            Text("\(computerName) · Checked \(humanDate(checked))").font(NativeStyle.caption).foregroundStyle(.secondary)
        } else { Text("Metadata has not been read on \(computerName).").font(NativeStyle.caption).foregroundStyle(.secondary) }
    }

    @ViewBuilder private var refreshActions: some View {
        Button(section == "Models" ? "Refresh models" : "Refresh usage", systemImage: "arrow.clockwise") { Task { await load(refresh: true) } }
            .disabled(working || !client.connected || client.projectID.isEmpty)
        if section == "Models" {
            Button("Update scores", systemImage: "chart.bar") { Task { await loadBenchmarks(refresh: true) } }.disabled(benchmarkBusy || !client.connected)
        }
    }

    private func providerName(_ id: String) -> String {
        switch id {
        case "codex": return "Codex"
        case "claude": return "Claude Code"
        case "opencode": return "OpenCode"
        case "antigravity": return "Antigravity"
        case "muse": return "Muse"
        case "cursor-agent": return "Cursor"
        case "zcode": return "ZCode"
        default: return id.isEmpty ? "Harness" : id.capitalized
        }
    }

    private func harnessLabel(_ harness: String) -> some View {
        HStack(spacing: 8) {
            NativeHarnessIcon(harness: harness)
            Text(providerName(harness)).font(.system(size: 14, weight: .medium))
        }
    }
    private var catalogControls: some View {
        VStack(alignment: .leading, spacing: 16) {
            modelSearch
            harnessPicker
        }
    }
    private var harnessPicker: some View {
        NativePageTabs(selection: Binding(
            get: { harnessFilter.isEmpty ? "All" : providerName(harnessFilter) },
            set: { name in harnessFilter = harnessEntries.first { providerName($0["harness"].string ?? "") == name }?["harness"].string ?? "" }
        ), items: ["All"] + harnessEntries.map { providerName($0["harness"].string ?? "") })
            .accessibilityLabel("Filter models by harness")
    }
    private var modelSearch: some View {
        NativeSearchField(placeholder: "Search models", text: $search)
    }
    private var modelList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("\(modelRows.count) models").font(NativeStyle.heading)
                Spacer()
                Text("Access and tools need native verification.").font(NativeStyle.caption).foregroundStyle(.secondary)
            }.padding(.bottom, 12)
            Divider()
            if modelRows.isEmpty {
                Text(search.isEmpty && harnessFilter.isEmpty ? "No models reported. Refresh models or check Sources." : "No matching models")
                    .foregroundStyle(.secondary).padding(.vertical, 16)
            }
            ForEach(modelRows) { row in
                Button { selectedModel = row } label: { modelRow(row) }
                    .buttonStyle(.plain).accessibilityHint("Open model details")
                Divider()
            }
        }
    }
    private func modelRow(_ row: CatalogModel) -> some View {
        HStack(spacing: 14) {
            NativeHarnessIcon(harness: row.harness).frame(width: 28)
            VStack(alignment: .leading, spacing: 5) {
                Text(row.model["name"].string ?? row.model["id"].string ?? "Model").font(NativeStyle.heading)
                    .fixedSize(horizontal: false, vertical: true)
                Text("\(providerName(row.harness)) · Images \(visionStatus(row.model))\(row.model["isDefault"].bool == true ? " · Native default" : "")")
                    .font(NativeStyle.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
            Text("Details").font(NativeStyle.caption).foregroundStyle(.tint)
        }.padding(.vertical, 12).contentShape(Rectangle())
    }
    private var nativeSources: some View {
        VStack(alignment: .leading, spacing: 12) {
            NativeSectionTitle(title: "Sources")
            VStack(alignment: .leading, spacing: 12) {
                ForEach(harnessEntries.filter { harnessFilter.isEmpty || $0["harness"].string == harnessFilter }, id: \.self) { entry in
                    let harness = entry["harness"].string ?? ""
                    HStack(spacing: 12) {
                        harnessLabel(harness)
                        Text("\((entry["models"].array ?? []).count) models").font(NativeStyle.caption).foregroundStyle(.secondary)
                        if entry["modelsStatus"].string == "unavailable" { Text("List unavailable").font(NativeStyle.caption).foregroundStyle(.secondary) }
                        if entry["modelsTruncated"].bool == true { Text("Shortened").font(NativeStyle.caption).foregroundStyle(.orange) }
                        if entry["auth"]["status"].string == "sign_in_required" { Text("Sign-in needed").font(NativeStyle.caption).foregroundStyle(.orange) }
                        if harness == "opencode", let providers = entry["connectedProviderIds"].array {
                            Text(providers.isEmpty ? "No connected providers" : "\(providers.count) providers")
                                .font(NativeStyle.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Details") { selectedModel = CatalogModel(id: "source:" + harness, entry: entry, model: .null) }
                            .buttonStyle(.plain).foregroundStyle(.tint)
                    }.padding(.vertical, 4)
                }
            }.padding(.top, 12)
        }
    }

    private var usageSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            NativeSectionTitle(title: "Task usage", subtitle: "This project · This Mac")
            VStack(alignment: .leading, spacing: 16) {
                let tokens = projectRuns.compactMap { $0["tokens"].number }.reduce(0, +)
                HStack(spacing: 24) { usageStatistics(tokens) }.padding(.vertical, 8)
                NativeDetailButton("Task usage details") {
                    Text("Tokens come from native worker events. Zero means no tokens were reported; it does not mean the work was free. Account allowance is separate.")
                        .foregroundStyle(.secondary)
                    Text("Dollar cost is unknown.").foregroundStyle(.secondary)
                    ForEach(projectRuns.filter { $0["museSubscriptionUsage"]["observedAtMs"].number != nil }.sorted { ($0["museSubscriptionUsage"]["observedAtMs"].number ?? 0) > ($1["museSubscriptionUsage"]["observedAtMs"].number ?? 0) }.prefix(1).map { $0 }, id: \.self) { run in
                        Divider()
                        Text("Muse · latest worker observation").font(NativeStyle.heading)
                        percent("Weekly", run["museSubscriptionUsage"]["weekly"])
                        percent("Session window", run["museSubscriptionUsage"]["window"])
                    }
                }
                    .buttonStyle(.plain).foregroundStyle(.tint)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func usageStatistics(_ tokens: Double) -> some View {
        statistic("Reported tokens", tokens.formatted(.number.precision(.fractionLength(0))), "number")
        statistic("Tasks with unknown usage", String(projectRuns.filter { $0["tokens"].number == nil }.count), "questionmark.circle")
        statistic("Dollar cost", "Unknown", "dollarsign.circle")
    }
    private func statistic(_ title: String, _ value: String, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: icon).font(NativeStyle.caption).foregroundStyle(.secondary)
            Text(value).font(.system(size: 18, weight: .semibold)).monospacedDigit()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func modelInspector(_ row: CatalogModel) -> some View {
        NativeDetailPage(title: row.model == .null ? "\(providerName(row.harness)) source" : row.model["name"].string ?? row.model["id"].string ?? "Model details") {
            HStack {
                harnessLabel(row.harness)
                Text(computerName).font(NativeStyle.caption).foregroundStyle(.secondary)
            }
            Divider()
            VStack(alignment: .leading, spacing: 12) {
                if row.model != .null {
                    Text("Model ID: \(row.model["id"].string ?? "Unknown")").textSelection(.enabled)
                    if let resolved = row.model["resolvedModel"].string { Text("Resolves to: \(resolved)").textSelection(.enabled) }
                    if let description = row.model["description"].string, !description.isEmpty { Text(description).foregroundStyle(.secondary) }
                    Divider()
                    Text("Capabilities").font(NativeStyle.heading)
                    capabilityDetails(row.model)
                }
                Divider()
                Text("Native source and access").font(NativeStyle.heading)
                if let message = row.entry["auth"]["message"].string { Text(message) }
                if let message = row.entry["modelsMessage"].string { Text(message) }
                if row.harness == "opencode", let providers = row.entry["connectedProviderIds"].array {
                    let ids = providers.compactMap(\.string)
                    Text(ids.isEmpty ? "No providers connected in OpenCode on \(computerName)." : "Connected providers on \(computerName): \(ids.joined(separator: ", ")).")
                    if ids.isEmpty { Text("Choose another computer to read its connected providers and models.").foregroundStyle(.secondary) }
                }
                Text("Native descriptions are metadata. Effective tools and model access remain unknown until checked in a native session.")
                if let checked = visibleCatalog["checkedAt"].string { Text("Metadata checked: \(checked)").textSelection(.enabled) }
                if row.entry["modelsTruncated"].bool == true { Text("Native list was shortened").foregroundStyle(.orange) }
                if row.model != .null {
                    Divider()
                    Text("Benchmarks").font(NativeStyle.heading)
                    benchmarkDetail(harness: row.harness, model: row.model["resolvedModel"].string ?? row.model["id"].string ?? "")
                    benchmarkBasis
                }
            }.font(NativeStyle.body).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func visionStatus(_ model: JSON) -> String {
        guard let modalities = model["inputModalities"].array else { return "unknown" }
        return modalities.contains { $0.string == "image" } ? "advertised" : "not advertised"
    }
    private func capabilityDetails(_ model: JSON) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Image input: \(visionStatus(model))")
            Text("Input modalities: " + (model["inputModalities"].array?.compactMap(\.string).joined(separator: ", ") ?? "Unknown"))
            if let evidence = model["toolEvidence"].objectValue {
                let names = evidence["tools"]?.array?.compactMap(\.string) ?? []
                Text("Advertised tools: " + (names.isEmpty ? "Unknown" : names.joined(separator: ", "))).textSelection(.enabled)
                Text(evidence["message"]?.string ?? "Advertised metadata does not grant tool permission.")
                if let source = evidence["source"]?.string { Text("Tool source: \(source)") }
                if let checked = evidence["checkedAt"]?.string { Text("Tool metadata checked: \(checked)").textSelection(.enabled) }
            } else { Text("Effective web search / image generation: unknown") }
        }.foregroundStyle(.secondary)
    }

    private func allowanceRow(_ entry: JSON) -> some View {
        let harness = entry["harness"].string ?? ""
        let value = entry["quota"]
        let windows = (value["buckets"].array ?? []).flatMap { [$0["primary"], $0["secondary"]] }
        let used = windows.compactMap { $0["usedPercent"].number }.filter { $0.isFinite && $0 >= 0 }.max()
        let spendReached = (value["buckets"].array ?? []).contains { $0["spendControlReached"].bool == true }
        return Button { selectedAllowance = CatalogAllowance(id: harness, entry: entry) } label: {
            HStack(spacing: 20) {
                harnessLabel(harness).frame(width: 160, alignment: .leading)
                VStack(alignment: .leading, spacing: 5) {
                    if let used { Text("\(used.formatted(.number.precision(.fractionLength(0...1))))% used · highest reported window").font(NativeStyle.body) }
                    else { Text(value["status"].string == "available" ? "Window usage unknown" : "Allowance unavailable").font(NativeStyle.body).foregroundStyle(.secondary) }
                    Text(value["ordinaryUsageAllowed"].bool.map { $0 ? "Included usage allowed" : "Included usage blocked" } ?? "Included usage permission unknown")
                        .font(NativeStyle.caption).foregroundStyle(value["ordinaryUsageAllowed"].bool == false ? Color.orange : Color.secondary)
                    if spendReached { Text("Spend limit reached").font(NativeStyle.caption).foregroundStyle(.orange) }
                }.frame(maxWidth: .infinity, alignment: .leading)
                if let used { ProgressView(value: min(used, 100), total: 100).frame(width: 120).accessibilityLabel("Highest reported allowance window").accessibilityValue("\(used.formatted()) percent used") }
                Text("Details").font(NativeStyle.caption).foregroundStyle(.tint)
            }.padding(.vertical, 12).contentShape(Rectangle())
        }.buttonStyle(.plain).accessibilityHint("Open \(providerName(harness)) allowance details")
    }

    private func quota(_ value: JSON) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(value["ordinaryUsageAllowed"].bool.map { $0 ? "Included usage allowed" : "Included usage blocked" } ?? "Included usage permission unknown", systemImage: value["ordinaryUsageAllowed"].bool == true ? "checkmark.circle" : "questionmark.circle")
            if let observed = value["observedAt"].string { Text("Observed \(humanDate(observed))").font(NativeStyle.caption).foregroundStyle(.secondary) }
            if value["status"].string != "available" { Text("Account allowance unavailable").foregroundStyle(.secondary) }
            ForEach(value["buckets"].array ?? [], id: \.self) { bucket in
                Divider()
                Text(bucket["name"].string ?? bucket["id"].string ?? "Allowance").font(NativeStyle.heading)
                if let model = bucket["normalModel"].string { Text("Model: \(model)").font(NativeStyle.caption).textSelection(.enabled) }
                percent("Primary window", bucket["primary"])
                percent("Secondary window", bucket["secondary"])
                Text(bucket["spendControlReached"].bool.map { $0 ? "Spend control: limit reached" : "Spend control: limit not reached" } ?? "Spend control: unknown").font(NativeStyle.caption).foregroundStyle(.secondary)
            }
            if let message = value["message"].string { Text(message).font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
    @ViewBuilder private func percent(_ title: String, _ window: JSON) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            if let used = window["usedPercent"].number, used.isFinite, used >= 0 {
                LabeledContent(title, value: "\(used.formatted(.number.precision(.fractionLength(0...1))))% used")
                ProgressView(value: min(used, 100), total: 100).accessibilityLabel(title).accessibilityValue("\(used.formatted()) percent used")
                VStack(alignment: .leading, spacing: 3) {
                    if let minutes = window["windowDurationMins"].number { Text("\(minutes.formatted()) minute window") }
                    if let reset = window["resetsAt"].number { Text("Resets \(humanDate(Date(timeIntervalSince1970: reset)))") }
                    if let reset = window["resetsAtMs"].number { Text("Resets \(humanDate(Date(timeIntervalSince1970: reset / 1000)))") }
                }.font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else { LabeledContent(title, value: "Unknown").foregroundStyle(.secondary) }
        }
    }
    private var benchmarkSummary: some View {
        VStack(alignment: .leading, spacing: 8) {
            ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { benchmarkSummaryContent }.fixedSize(horizontal: true, vertical: false)
                    VStack(alignment: .leading, spacing: 8) { benchmarkSummaryContent }
            }
            if !benchmarkFailure.isEmpty { Text(benchmarkFailure).foregroundStyle(.red) }
        }
    }
    @ViewBuilder private var benchmarkSummaryContent: some View {
        Label("LiveBench reference", systemImage: "chart.bar").font(NativeStyle.caption)
        Text((benchmarkFresh ? "Fresh" : "Stale") + (benchmarks["checkedAt"].string.map { " · checked \(humanDate($0))" } ?? ""))
            .font(NativeStyle.caption).foregroundStyle(.secondary)
        if benchmarkBusy { ProgressView().controlSize(.regular).accessibilityLabel("Reading public scores") }
        Button("About scores") { showingBenchmarks = true }.controlSize(.regular)
    }
    private var benchmarkInspector: some View {
        NativeDetailPage(title: "LiveBench reference") {
            benchmarkBasis
            if benchmarkBusy { ProgressView("Reading public scores…") }
            if !benchmarkFailure.isEmpty { Text(benchmarkFailure).foregroundStyle(.red) }
        }
    }
    private var benchmarkBasis: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Max-effort scores are reference evidence. They do not predict task results or subscription cost.")
            Text(benchmarkFresh ? "Fresh: may break policy ties" : "Stale: excluded from tie breaking")
            Text("Release: \(benchmarks["release"].string ?? "Unknown")")
            if let checked = benchmarks["checkedAt"].string { Text("Checked: \(checked)").textSelection(.enabled) }
            Text("Only exact reviewed model IDs have scores. Evaluation dates are unknown.")
            Link("LiveBench source scores", destination: URL(string: "https://livebench.ai/table_2026_06_25.csv")!)
        }.font(NativeStyle.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
    private var benchmarkFresh: Bool {
        guard let text = benchmarks["checkedAt"].string else { return false }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { return false }
        let age = Date().timeIntervalSince(date); return age >= 0 && age <= 7 * 86400
    }
    @ViewBuilder private func benchmarkDetail(harness: String, model: String) -> some View {
        if let row = (benchmarks["models"].array ?? []).first(where: { $0["harness"].string == harness && $0["model"].string == model }) {
            Divider()
            Text("LiveBench reference").font(.caption.weight(.semibold))
            ForEach((row["scores"].objectValue ?? [:]).keys.sorted(), id: \.self) { metric in
                Text("\(metric): \(row["scores"][metric].number.map { String(format: "%.2f", $0) } ?? "Unknown")/100")
            }
            Text("Source row: \(row["sourceRow"].string ?? "Unknown") · Effort: \(benchmarks["measuredEffort"].string ?? "Unknown")")
            Link("LiveBench source scores", destination: URL(string: "https://livebench.ai/table_2026_06_25.csv")!)
        } else { Text("Benchmark: no exact model match") }
    }
    private func humanDate(_ text: String) -> String {
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { return "date unknown" }
        return humanDate(date)
    }
    private func humanDate(_ date: Date) -> String {
        if abs(date.timeIntervalSinceNow) < 86400 {
            let formatter = RelativeDateTimeFormatter(); formatter.unitsStyle = .full
            return formatter.localizedString(for: date, relativeTo: Date())
        }
        return date.formatted(date: .abbreviated, time: .shortened)
    }
    private func loadBenchmarks(refresh: Bool) async {
        guard client.connected, !benchmarkBusy else { return }
        let captured = scope
        benchmarkBusy = true; benchmarkFailure = ""; defer { benchmarkBusy = false }
        do {
            let value = try await client.request(refresh ? "/benchmarks/refresh" : "/benchmarks", body: refresh ? [:] : nil)
            if !Task.isCancelled, captured == scope, client.connected { benchmarks = value }
        }
        catch { if !Task.isCancelled, captured == scope, client.connected { benchmarkFailure = error.localizedDescription } }
    }
    private func load(refresh: Bool) async {
        guard client.connected, !client.projectID.isEmpty, !working else { return }
        let captured = scope, requestID = UUID()
        guard captured.computerID.isEmpty || captured.peer != .null else { return }
        loadID = requestID; working = true; failure = ""
        defer { if loadID == requestID { working = false; loadID = nil } }
        do {
            let value: JSON
            if captured.computerID.isEmpty {
                value = try await client.request("/projects/\(captured.projectID)/catalog", body: refresh ? [:] : nil)
            } else {
                value = try await client.request("/peers/\(captured.computerID)/catalog?projectId=\(captured.projectID)")
            }
            guard !Task.isCancelled, captured == scope, client.connected, loadID == requestID else { return }
            let expectedProject = captured.computerID.isEmpty ? captured.projectID : captured.peer["remoteProjectId"].string
            guard value == .null || value["projectId"].string == expectedProject else {
                failure = "The catalog does not match the selected project and computer."; return
            }
            catalog = value; catalogScope = captured
        } catch { if !Task.isCancelled, captured == scope, client.connected, loadID == requestID { failure = error.localizedDescription } }
    }
}
