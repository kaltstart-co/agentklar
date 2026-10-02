import SwiftUI

struct ModelUsageView: View {
    @ObservedObject var client: AgentKlarClient
    let section: String
    var active = true
    @State private var catalog: JSON = .null
    @State private var working = false
    @State private var failure = ""
    @State private var search = ""
    @State private var harnessFilter = ""
    @State private var selectedModel: CatalogModel?
    @State private var showingBenchmarks = false
    private struct CatalogModel: Identifiable {
        let id: String
        let entry: JSON
        let model: JSON
        var harness: String { entry["harness"].string ?? "" }
    }
    private var harnessEntries: [JSON] { catalog["harnesses"].array ?? [] }
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
                NativePageHeader(title: section, subtitle: section == "Models" ? "Models offered by your native harnesses." : "Reported work usage and account allowance.") {
                    if active { refreshActions.controlSize(.regular).labelStyle(.titleAndIcon) }
                }
                if section == "Models" {
                    VStack(alignment: .leading, spacing: 12) {
                        catalogControls
                        metadataStatus
                    }
                    modelList
                    nativeSources
                    benchmarkSummary
                } else {
                    metadataStatus
                    usageSection
                    ForEach(harnessEntries, id: \.self) { entry in
                        Divider()
                        harnessLabel(entry["harness"].string ?? "")
                        quota(entry["quota"])
                    }
                }
            }.font(NativeStyle.body).padding(NativeStyle.pagePadding).frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(item: $selectedModel) { row in modelInspector(row) }
        .sheet(isPresented: $showingBenchmarks) { benchmarkInspector }

        .task(id: client.projectID + ":" + String(client.connected)) {
            catalog = .null; failure = ""; selectedModel = nil
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if !Task.isCancelled { await load(refresh: false); await loadBenchmarks(refresh: false) }
        }
    }

    @ViewBuilder private var metadataStatus: some View {
        if working { ProgressView("Reading native metadata…") }
        if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        if let checked = catalog["checkedAt"].string {
            Label("Native metadata checked \(humanDate(checked))", systemImage: "clock").font(NativeStyle.caption).foregroundStyle(.secondary)
        } else { Text("Native metadata has not been read for this project.").foregroundStyle(.secondary) }
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
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 12) { harnessPicker; modelSearch }
            VStack(alignment: .leading, spacing: 12) { harnessPicker; modelSearch }
        }
    }
    private var harnessPicker: some View {
        Picker("Harness", selection: $harnessFilter) {
            Text("All harnesses").tag("")
            ForEach(harnessEntries, id: \.self) { entry in
                let id = entry["harness"].string ?? ""
                Text(providerName(id)).tag(id)
            }
        }.pickerStyle(.menu).accessibilityLabel("Filter models by harness")
    }
    private var modelSearch: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search models", text: $search).textFieldStyle(.plain).font(NativeStyle.body)
            if !search.isEmpty {
                Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Clear search")
            }
        }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }
    private var modelList: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 16) {
                Text("Harness").frame(width: 120, alignment: .leading)
                Text("Model and capabilities").frame(maxWidth: .infinity, alignment: .leading)
            }.font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary).padding(.vertical, 12)
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
        HStack(alignment: .top, spacing: 16) {
            harnessLabel(row.harness).frame(width: 120, alignment: .leading)
            VStack(alignment: .leading, spacing: 8) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { modelHeading(row.model) }.fixedSize(horizontal: true, vertical: false)
                    VStack(alignment: .leading, spacing: 4) { modelHeading(row.model) }
                }
                Text("Vision \(visionStatus(row.model))").font(NativeStyle.caption).foregroundStyle(.secondary)
                if let description = row.model["description"].string, !description.isEmpty {
                    Text(description).font(NativeStyle.body).foregroundStyle(.secondary).lineLimit(2)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(NativeStyle.caption).foregroundStyle(.secondary).padding(.top, 4)
        }.padding(.vertical, 16).contentShape(Rectangle())
    }
    private var nativeSources: some View {
        VStack(alignment: .leading, spacing: 12) {
            NativeSectionTitle(title: "Sources")
            VStack(alignment: .leading, spacing: 12) {
                ForEach(harnessEntries.filter { harnessFilter.isEmpty || $0["harness"].string == harnessFilter }, id: \.self) { entry in
                    let harness = entry["harness"].string ?? ""
                    HStack {
                        harnessLabel(harness)
                        Spacer()
                        if entry["modelsStatus"].string == "unavailable" { Text("List unavailable").font(NativeStyle.caption).foregroundStyle(.secondary) }
                        if entry["modelsTruncated"].bool == true { Text("List shortened").font(NativeStyle.caption).foregroundStyle(.orange) }
                        Button("Source details") { selectedModel = CatalogModel(id: "source:" + harness, entry: entry, model: .null) }
                    }
                }
            }.padding(.top, 12)
        }
    }

    private var usageSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Reported task usage").font(NativeStyle.heading)
            VStack(alignment: .leading, spacing: 16) {
                let tokens = projectRuns.compactMap { $0["tokens"].number }.reduce(0, +)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { usageStatistics(tokens) }.fixedSize(horizontal: true, vertical: false)
                    VStack(alignment: .leading, spacing: 12) { usageStatistics(tokens) }
                }
                Text("Tokens come from native worker events. Zero means no tokens were reported; it does not mean the work was free. Account allowance is separate.").font(NativeStyle.caption).foregroundStyle(.secondary)
                ForEach(projectRuns.filter { $0["museSubscriptionUsage"]["observedAtMs"].number != nil }.sorted { ($0["museSubscriptionUsage"]["observedAtMs"].number ?? 0) > ($1["museSubscriptionUsage"]["observedAtMs"].number ?? 0) }.prefix(1).map { $0 }, id: \.self) { run in
                    Divider()
                    Text("Muse · latest worker observation").font(NativeStyle.heading)
                    percent("Weekly", run["museSubscriptionUsage"]["weekly"])
                    percent("Session window", run["museSubscriptionUsage"]["window"])
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func usageStatistics(_ tokens: Double) -> some View {
        statistic("Reported tokens", tokens.formatted(.number.precision(.fractionLength(0))), "number")
        statistic("Unknown task usage", String(projectRuns.filter { $0["tokens"].number == nil }.count), "questionmark.circle")
        statistic("Dollar cost", "Unknown", "dollarsign.circle")
    }
    private func statistic(_ title: String, _ value: String, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: icon).font(NativeStyle.caption).foregroundStyle(.secondary)
            Text(value).font(.system(size: 18, weight: .semibold)).monospacedDigit()
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func modelInspector(_ row: CatalogModel) -> some View {
        VStack(spacing: 0) {
            HStack {
                harnessLabel(row.harness)
                Spacer()
                Button("Done") { selectedModel = nil }.keyboardShortcut(.cancelAction)
            }.padding(NativeStyle.pagePadding)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if row.model != .null {
                        Text(row.model["name"].string ?? row.model["id"].string ?? "Model").font(NativeStyle.heading)
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
                    Text("Native descriptions are metadata. Effective tools and model access remain unknown until checked in a native session.")
                    if let checked = catalog["checkedAt"].string { Text("Metadata checked: \(checked)").textSelection(.enabled) }
                    if row.entry["modelsTruncated"].bool == true { Text("Native list was shortened").foregroundStyle(.orange) }
                    if row.model != .null {
                        Divider()
                        Text("Benchmarks").font(NativeStyle.heading)
                        benchmarkDetail(harness: row.harness, model: row.model["resolvedModel"].string ?? row.model["id"].string ?? "")
                        benchmarkBasis
                    }
                }.font(NativeStyle.body).fixedSize(horizontal: false, vertical: true).padding(NativeStyle.pagePadding).frame(maxWidth: .infinity, alignment: .leading)
            }
        }.frame(minWidth: 480, idealWidth: 600, minHeight: 400, idealHeight: 620)
    }
    @ViewBuilder private func modelHeading(_ model: JSON) -> some View {
        Text(model["name"].string ?? model["id"].string ?? "Model").font(NativeStyle.heading).fixedSize(horizontal: false, vertical: true)
        if model["isDefault"].bool == true { Label("Native default", systemImage: "checkmark.circle").font(NativeStyle.caption).foregroundStyle(.secondary) }
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
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("LiveBench reference").font(NativeStyle.heading)
                Spacer()
                Button("Done") { showingBenchmarks = false }.keyboardShortcut(.cancelAction)
            }
            Divider()
            benchmarkBasis
            if benchmarkBusy { ProgressView("Reading public scores…") }
            if !benchmarkFailure.isEmpty { Text(benchmarkFailure).foregroundStyle(.red) }
        }.padding(NativeStyle.pagePadding).frame(minWidth: 480, idealWidth: 600).fixedSize(horizontal: false, vertical: true)
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
        benchmarkBusy = true; benchmarkFailure = ""; defer { benchmarkBusy = false }
        do { benchmarks = try await client.request(refresh ? "/benchmarks/refresh" : "/benchmarks", body: refresh ? [:] : nil) }
        catch { benchmarkFailure = error.localizedDescription }
    }
    private func load(refresh: Bool) async {
        guard client.connected, !client.projectID.isEmpty, !working else { return }
        let project = client.projectID
        working = true; failure = ""
        defer { working = false }
        do {
            let value = try await client.request("/projects/\(project)/catalog", body: refresh ? [:] : nil)
            if project == client.projectID { catalog = value }
        } catch { if project == client.projectID { failure = error.localizedDescription } }
    }
}
