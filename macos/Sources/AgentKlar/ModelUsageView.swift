import SwiftUI

struct ModelUsageView: View {
    @ObservedObject var client: AgentKlarClient
    let section: String
    @State private var catalog: JSON = .null
    @State private var working = false
    @State private var failure = ""
    @State private var search = ""
    @State private var benchmarks: JSON = .null
    @State private var benchmarkBusy = false
    @State private var benchmarkFailure = ""
    private var projectRuns: [JSON] { client.runs.filter { $0["projectId"].string == client.projectID } }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                metadataStatus
                if section == "Models" {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("Find a model", text: $search).textFieldStyle(.plain)
                        if !search.isEmpty {
                            Button { search = "" } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("Clear search")
                        }
                    }.padding(10).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                    benchmarkSummary
                } else { usageSection }
                ForEach(catalog["harnesses"].array ?? [], id: \.self) { entry in
                    provider(entry)
                }
            }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(section)
        .toolbar { ToolbarItemGroup { refreshActions } }
        .task(id: client.projectID + ":" + String(client.connected)) {
            catalog = .null; failure = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if !Task.isCancelled { await load(refresh: false); await loadBenchmarks(refresh: false) }
        }
    }

    @ViewBuilder private var metadataStatus: some View {
        if working { ProgressView("Reading native metadata…") }
        if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        if let checked = catalog["checkedAt"].string {
            Label("Native metadata checked \(humanDate(checked))", systemImage: "clock").font(.caption).foregroundStyle(.secondary)
        } else { Text("Native metadata has not been read for this project.").foregroundStyle(.secondary) }
    }

    @ViewBuilder private var refreshActions: some View {
        Button("Refresh native metadata", systemImage: "arrow.clockwise") { Task { await load(refresh: true) } }
            .disabled(working || !client.connected || client.projectID.isEmpty)
        if section == "Models" {
            Button("Refresh benchmarks", systemImage: "chart.bar") { Task { await loadBenchmarks(refresh: true) } }.disabled(benchmarkBusy || !client.connected)
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

    private func provider(_ entry: JSON) -> some View {
        let harness = entry["harness"].string ?? ""
        return VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                NativeHarnessIcon(harness: harness)
                Text(providerName(harness)).font(.headline)
                Spacer()
                if section == "Models" { Text("\((entry["models"].array ?? []).count) models").font(.caption).foregroundStyle(.secondary) }
            }.padding(.top, 8)
            if section == "Models" { models(entry) } else { quota(entry["quota"]) }
        }
    }

    private var usageSection: some View {
        GroupBox("Reported task usage") {
            VStack(alignment: .leading, spacing: 12) {
                let tokens = projectRuns.compactMap { $0["tokens"].number }.reduce(0, +)
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 12) { usageStatistics(tokens) }.fixedSize(horizontal: true, vertical: false)
                    VStack(alignment: .leading, spacing: 12) { usageStatistics(tokens) }
                }
                Text("Tokens come from native worker events. Zero means no tokens were reported; it does not mean the work was free. Account allowance is separate.").font(.caption).foregroundStyle(.secondary)
                ForEach(projectRuns.filter { $0["museSubscriptionUsage"]["observedAtMs"].number != nil }.sorted { ($0["museSubscriptionUsage"]["observedAtMs"].number ?? 0) > ($1["museSubscriptionUsage"]["observedAtMs"].number ?? 0) }.prefix(1).map { $0 }, id: \.self) { run in
                    Divider()
                    Text("Muse · latest worker observation").font(.headline)
                    percent("Weekly", run["museSubscriptionUsage"]["weekly"])
                    percent("Session window", run["museSubscriptionUsage"]["window"])
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func usageStatistics(_ tokens: Double) -> some View {
        statistic("Reported tokens", tokens.formatted(.number.precision(.fractionLength(0))), "number")
        statistic("Unknown task usage", String(projectRuns.filter { $0["tokens"].number == nil }.count), "questionmark.circle")
        statistic("Dollar cost", "Unknown", "dollarsign.circle")
    }
    private func statistic(_ title: String, _ value: String, _ icon: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: icon).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.body.weight(.semibold))
        }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder private func models(_ entry: JSON) -> some View {
        DisclosureGroup("Native source and access") {
            VStack(alignment: .leading, spacing: 6) {
                if let message = entry["auth"]["message"].string { Text(message) }
                if let message = entry["modelsMessage"].string { Text(message) }
                Text("Native descriptions are metadata. Effective tools and model access remain unknown until checked in a native session.")
                if let checked = catalog["checkedAt"].string { Text("Metadata checked: \(checked)").textSelection(.enabled) }
            }.font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        if entry["modelsStatus"].string == "unavailable" { Label("Model list unavailable", systemImage: "questionmark.circle").foregroundStyle(.secondary) }
        if entry["modelsTruncated"].bool == true { Label("Native list was shortened", systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
        let matching = (entry["models"].array ?? []).filter { search.isEmpty || (($0["name"].string ?? "") + " " + ($0["id"].string ?? "")).localizedCaseInsensitiveContains(search) }
        if matching.isEmpty, !search.isEmpty { Text("No matching models").foregroundStyle(.secondary) }
        ForEach(matching, id: \.self) { model in
            GroupBox {
                VStack(alignment: .leading, spacing: 6) {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) { modelHeading(model) }.fixedSize(horizontal: true, vertical: false)
                        VStack(alignment: .leading, spacing: 4) { modelHeading(model) }
                    }
                    Label("Vision \(visionStatus(model))", systemImage: "photo").font(.caption).foregroundStyle(.secondary)
                    if let description = model["description"].string, !description.isEmpty { Text(description).font(.callout).foregroundStyle(.secondary).lineLimit(2) }
                    DisclosureGroup("Details") {
                        modelDetails(model, harness: entry["harness"].string ?? "")
                    }.font(.caption)
                }.padding(6).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
    @ViewBuilder private func modelHeading(_ model: JSON) -> some View {
        Text(model["name"].string ?? model["id"].string ?? "Model").font(.body.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
        if model["isDefault"].bool == true { Label("Native default", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary) }
    }
    private func visionStatus(_ model: JSON) -> String {
        guard let modalities = model["inputModalities"].array else { return "unknown" }
        return modalities.contains { $0.string == "image" } ? "advertised" : "not advertised"
    }
    private func modelDetails(_ model: JSON, harness: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Image input: \(visionStatus(model))")
            Text("Input modalities: " + (model["inputModalities"].array?.compactMap(\.string).joined(separator: ", ") ?? "Unknown"))
            Text("Model ID: \(model["id"].string ?? "Unknown")").textSelection(.enabled)
            if let resolved = model["resolvedModel"].string { Text("Resolves to: \(resolved)").textSelection(.enabled) }
            if let description = model["description"].string, !description.isEmpty { Text(description) }
            if let evidence = model["toolEvidence"].objectValue {
                let names = evidence["tools"]?.array?.compactMap(\.string) ?? []
                Text("Advertised tools: " + (names.isEmpty ? "Unknown" : names.joined(separator: ", "))).textSelection(.enabled)
                Text(evidence["message"]?.string ?? "Advertised metadata does not grant tool permission.")
                if let source = evidence["source"]?.string { Text("Tool source: \(source)") }
                if let checked = evidence["checkedAt"]?.string { Text("Tool metadata checked: \(checked)").textSelection(.enabled) }
            } else { Text("Effective web search / image generation: unknown") }
            benchmarkDetail(harness: harness, model: model["resolvedModel"].string ?? model["id"].string ?? "")
        }.foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
    }

    private func quota(_ value: JSON) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 12) {
                Label(value["ordinaryUsageAllowed"].bool.map { $0 ? "Included usage allowed" : "Included usage blocked" } ?? "Included usage permission unknown", systemImage: value["ordinaryUsageAllowed"].bool == true ? "checkmark.circle" : "questionmark.circle")
                if let observed = value["observedAt"].string { Text("Observed \(humanDate(observed))").font(.caption).foregroundStyle(.secondary) }
                if value["status"].string != "available" { Text("Account allowance unavailable").foregroundStyle(.secondary) }
                ForEach(value["buckets"].array ?? [], id: \.self) { bucket in
                    Divider()
                    Text(bucket["name"].string ?? bucket["id"].string ?? "Allowance").font(.body.weight(.semibold))
                    if let model = bucket["normalModel"].string { Text("Model: \(model)").font(.caption).textSelection(.enabled) }
                    percent("Primary window", bucket["primary"])
                    percent("Secondary window", bucket["secondary"])
                    Text(bucket["spendControlReached"].bool.map { $0 ? "Spend control: limit reached" : "Spend control: limit not reached" } ?? "Spend control: unknown").font(.caption).foregroundStyle(.secondary)
                }
                DisclosureGroup("Source details") {
                    VStack(alignment: .leading, spacing: 6) {
                        if let message = value["message"].string { Text(message) }
                        if let observed = value["observedAt"].string { Text("Observed: \(observed)").textSelection(.enabled) }
                    }.font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
        }
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
                }.font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else { LabeledContent(title, value: "Unknown").foregroundStyle(.secondary) }
        }
    }
    private var benchmarkSummary: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 6) {
                Text("Max-effort scores are reference evidence. They do not predict task results or subscription cost.")
                Text(benchmarkFresh ? "Fresh: may break policy ties" : "Stale: excluded from tie breaking")
                Text("Release: \(benchmarks["release"].string ?? "Unknown")")
                if let checked = benchmarks["checkedAt"].string { Text("Checked: \(checked)").textSelection(.enabled) }
                Text("Only exact reviewed model IDs have scores. Evaluation dates are unknown.")
                if benchmarkBusy { ProgressView("Reading public scores…") }
                if !benchmarkFailure.isEmpty { Text(benchmarkFailure).foregroundStyle(.red) }
            }.font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true).padding(.top, 6)
        } label: {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { benchmarkHeading }.fixedSize(horizontal: true, vertical: false)
                VStack(alignment: .leading, spacing: 4) { benchmarkHeading }
            }
        }
    }
    @ViewBuilder private var benchmarkHeading: some View {
        Label("LiveBench reference", systemImage: "chart.bar").font(.body)
        Text((benchmarkFresh ? "Fresh" : "Stale") + (benchmarks["checkedAt"].string.map { " · checked \(humanDate($0))" } ?? ""))
            .font(.caption).foregroundStyle(.secondary)
        if benchmarkBusy { ProgressView().controlSize(.small).accessibilityLabel("Reading public scores") }
        if !benchmarkFailure.isEmpty { Image(systemName: "exclamationmark.triangle").foregroundStyle(.red).accessibilityLabel(benchmarkFailure) }
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
