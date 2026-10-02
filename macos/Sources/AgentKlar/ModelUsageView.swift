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
        VStack(spacing: 0) {
            HStack {
                Text(section).font(.title2)
                Spacer()
                Button("Refresh native metadata", systemImage: "arrow.clockwise") { Task { await load(refresh: true) } }
                    .disabled(working || !client.connected || client.projectID.isEmpty)
                if section == "Models" {
                    Button("Refresh benchmarks") { Task { await loadBenchmarks(refresh: true) } }.disabled(benchmarkBusy || !client.connected)
                }
            }.padding()
        List {
            Section {
                if working { ProgressView("Reading native metadata…") }
                if let checked = catalog["checkedAt"].string { Text("Checked: \(checked)").font(.caption).foregroundStyle(.secondary) }
                if !failure.isEmpty { Label(failure, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                if catalog["checkedAt"].string == nil { Text("Native metadata has not been read for this project.").foregroundStyle(.secondary) }
            }
            if section == "Models" {
                Section { TextField("Find a model", text: $search); Text("Native descriptions are metadata. Effective tools and model access remain unknown until checked in a native session.").foregroundStyle(.secondary) }
            } else { usageSection }
            if section == "Models" { benchmarkSummary }
            ForEach(catalog["harnesses"].array ?? [], id: \.self) { entry in
                Section {
                    if section == "Models" { models(entry) } else { quota(entry["quota"]) }
                } header: {
                    HStack { NativeHarnessIcon(harness: entry["harness"].string ?? ""); Text(entry["harness"].string ?? "Harness") }
                }
            }
        }
        }
        .navigationTitle(section)
        .task(id: client.projectID + ":" + String(client.connected)) {
            catalog = .null; failure = ""
            while working { do { try await Task.sleep(for: .milliseconds(50)) } catch { return } }
            if !Task.isCancelled { await load(refresh: false); await loadBenchmarks(refresh: false) }
        }
    }

    private var usageSection: some View {
        Section("Reported task usage") {
            let tokens = projectRuns.compactMap { $0["tokens"].number }.reduce(0, +)
            LabeledContent("Reported tokens", value: tokens.formatted(.number.precision(.fractionLength(0))))
            LabeledContent("Tasks with unknown usage", value: String(projectRuns.filter { $0["tokens"].number == nil }.count))
            LabeledContent("Dollar cost", value: "Unknown")
            Text("Tokens come from native worker events. Zero means no tokens were reported; it does not mean the work was free. Account allowance is separate.").font(.caption).foregroundStyle(.secondary)
            ForEach(projectRuns.filter { $0["museSubscriptionUsage"]["observedAtMs"].number != nil }.sorted { ($0["museSubscriptionUsage"]["observedAtMs"].number ?? 0) > ($1["museSubscriptionUsage"]["observedAtMs"].number ?? 0) }.prefix(1).map { $0 }, id: \.self) { run in
                Text("Muse subscription usage reported by a native worker").font(.headline)
                percent("Weekly", run["museSubscriptionUsage"]["weekly"])
                percent("Session window", run["museSubscriptionUsage"]["window"])
            }
        }
    }
    @ViewBuilder private func models(_ entry: JSON) -> some View {
        if let message = entry["auth"]["message"].string { Text(message).foregroundStyle(.secondary) }
        if let message = entry["modelsMessage"].string { Text(message).foregroundStyle(.secondary) }
        if entry["modelsStatus"].string == "unavailable" { Text("Model list unavailable.") }
        if entry["modelsTruncated"].bool == true { Label("Native list was shortened", systemImage: "exclamationmark.triangle").foregroundStyle(.orange) }
        ForEach((entry["models"].array ?? []).filter { search.isEmpty || (($0["name"].string ?? "") + " " + ($0["id"].string ?? "")).localizedCaseInsensitiveContains(search) }, id: \.self) { model in
            VStack(alignment: .leading, spacing: 4) {
                HStack { Text(model["name"].string ?? model["id"].string ?? "Model").font(.headline); if model["isDefault"].bool == true { Text("Native default").font(.caption).foregroundStyle(.secondary) } }
                Text(model["id"].string ?? "Unknown model ID").font(.caption).textSelection(.enabled)
                if let description = model["description"].string, !description.isEmpty { Text(description).foregroundStyle(.secondary) }
                if let resolved = model["resolvedModel"].string { Text("Resolves to: \(resolved)").font(.caption) }
                if let evidence = model["toolEvidence"].objectValue {
                    let names = evidence["tools"]?.array?.compactMap(\.string) ?? []
                    Text("Advertised tools: " + (names.isEmpty ? "Unknown" : names.joined(separator: ", "))).font(.caption)
                    Text(evidence["message"]?.string ?? "Advertised metadata does not grant tool permission.").font(.caption).foregroundStyle(.secondary)
                } else { Text("Effective web search / image generation: unknown").font(.caption).foregroundStyle(.secondary) }
                benchmarkDetail(harness: entry["harness"].string ?? "", model: model["resolvedModel"].string ?? model["id"].string ?? "")
                Text("Image input: \(model["inputModalities"].array == nil ? "Unknown" : (model["inputModalities"].array ?? []).contains { $0.string == "image" } ? "Advertised" : "Not advertised")").font(.caption)
            }.padding(.vertical, 4)
        }
    }
    @ViewBuilder private func quota(_ value: JSON) -> some View {
        if let message = value["message"].string { Text(message).foregroundStyle(.secondary) }
        if let observed = value["observedAt"].string { Text("Observed: \(observed)").font(.caption) }
        Text(value["ordinaryUsageAllowed"].bool.map { $0 ? "Native included usage is allowed." : "Native included usage is blocked." } ?? "Included usage permission: unknown.")
        if value["status"].string != "available" { Text("Account allowance unavailable.").foregroundStyle(.secondary) }
        ForEach(value["buckets"].array ?? [], id: \.self) { bucket in
            Text(bucket["name"].string ?? bucket["id"].string ?? "Allowance").font(.headline)
            if let model = bucket["normalModel"].string { Text("Model: \(model)").font(.caption) }
            percent("Primary window", bucket["primary"])
            percent("Secondary window", bucket["secondary"])
            Text(bucket["spendControlReached"].bool.map { $0 ? "Spend control: limit reached" : "Spend control: limit not reached" } ?? "Spend control: unknown").font(.caption)
        }
    }
    @ViewBuilder private func percent(_ title: String, _ window: JSON) -> some View {
        if let used = window["usedPercent"].number, used.isFinite, (0...100).contains(used) {
            LabeledContent(title, value: "\(used.formatted(.number.precision(.fractionLength(0...1))))% used")
            if let minutes = window["windowDurationMins"].number { Text("Window: \(minutes.formatted()) minutes").font(.caption) }
            if let reset = window["resetsAt"].number { Text("Resets: \(Date(timeIntervalSince1970: reset).formatted())").font(.caption) }
            if let reset = window["resetsAtMs"].number { Text("Resets: \(Date(timeIntervalSince1970: reset / 1000).formatted())").font(.caption) }
        } else { LabeledContent(title, value: "Unknown") }
    }
    private var benchmarkSummary: some View {
        Section("LiveBench reference scores") {
            Text("Max-effort scores are reference evidence. They do not predict task results or subscription cost.").font(.caption)
            if let checked = benchmarks["checkedAt"].string {
                Text("Release \(benchmarks["release"].string ?? "Unknown") · Checked \(checked)").font(.caption)
                Text(benchmarkFresh ? "Fresh: may break policy ties" : "Stale: excluded from tie breaking").foregroundStyle(.secondary)
            }
            if benchmarkBusy { ProgressView("Reading public scores…") }
            if !benchmarkFailure.isEmpty { Text(benchmarkFailure).foregroundStyle(.red) }
            Text("Only exact reviewed model IDs have scores. Evaluation dates are unknown.").font(.caption).foregroundStyle(.secondary)
        }
    }
    private var benchmarkFresh: Bool {
        guard let text = benchmarks["checkedAt"].string else { return false }
        let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: text) ?? ISO8601DateFormatter().date(from: text) else { return false }
        let age = Date().timeIntervalSince(date); return age >= 0 && age <= 7 * 86400
    }
    @ViewBuilder private func benchmarkDetail(harness: String, model: String) -> some View {
        if let row = (benchmarks["models"].array ?? []).first(where: { $0["harness"].string == harness && $0["model"].string == model }) {
            DisclosureGroup("Benchmark reference") {
                ForEach((row["scores"].objectValue ?? [:]).keys.sorted(), id: \.self) { metric in
                    Text("\(metric): \(row["scores"][metric].number.map { String(format: "%.2f", $0) } ?? "Unknown")/100").font(.caption)
                }
                Text("Source row: \(row["sourceRow"].string ?? "Unknown") · Effort: \(benchmarks["measuredEffort"].string ?? "Unknown")").font(.caption)
                Link("LiveBench source scores", destination: URL(string: "https://livebench.ai/table_2026_06_25.csv")!)
            }
        } else { Text("Benchmark: no exact model match").font(.caption).foregroundStyle(.secondary) }
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
