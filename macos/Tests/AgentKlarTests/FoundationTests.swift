import XCTest
import AppKit
import CryptoKit
import ImageIO
@testable import AgentKlar

final class FoundationTests: XCTestCase {
    func testJSONKeepsUnknownAndExplicitZero() throws {
        let value = try JSONDecoder().decode(JSON.self, from: Data(#"{"zero":0,"false":false,"unknown":null,"items":["one"]}"#.utf8))
        XCTAssertEqual(value["zero"].number, 0); XCTAssertEqual(value["false"].bool, false)
        XCTAssertNil(value["unknown"].number); XCTAssertNil(value["missing"].string)
        XCTAssertEqual(value["items"].array, [.string("one")])
        XCTAssertEqual(JSON.any(["enabled": true, "remaining": 0]), .object(["enabled": .bool(true), "remaining": .number(0)]))
    }
    func testPrivateLocalLinksAndAPIOrigin() throws {
        let valid = "http://127.0.0.1:4317/setup?token=" + String(repeating: "a", count: 64)
        let origin = try LocalBoundary.setupURL(valid)
        for bad in [valid + "\nextra", valid.replacingOccurrences(of: "127.0.0.1", with: "example.com"), valid.replacingOccurrences(of: "4317", with: "99999")] {
            XCTAssertThrowsError(try LocalBoundary.setupURL(bad))
        }
        XCTAssertEqual(try LocalBoundary.apiURL("/snapshot", origin: origin).path, "/api/snapshot")
        for bad in ["/api/../../setup", "/api/%2e%2e/setup", "/api/x#fragment"] { XCTAssertThrowsError(try LocalBoundary.apiURL(bad, origin: origin)) }
        XCTAssertFalse(LocalBoundary.sameOrigin(URL(string: "http://127.0.0.1:4318/")!, origin))
        XCTAssertFalse(LocalBoundary.sameOrigin(URL(string: "http://user@127.0.0.1:4317/")!, origin))
        XCTAssertFalse(LocalBoundary.sameOrigin(URL(string: "https://example.com/")!, origin))
    }
    func testIdleGuardAndPrivateError() {
        XCTAssertTrue(LocalBoundary.idleService("Installed; running on http://127.0.0.1:4317; 0 active run(s)."))
        XCTAssertFalse(LocalBoundary.idleService("Installed; running on http://127.0.0.1:4317; 1 active run(s)."))
        XCTAssertFalse(LocalBoundary.idleService("Installed; stopped."))
        XCTAssertFalse(LocalBoundary.safeError("SECRET_TOKEN").contains("SECRET_TOKEN"))
    }
    @MainActor func testMutationGateHoldsThroughSuspensionAndReleasesAfterFailure() async throws {
        let runtime = LocalRuntime()
        let first = Task { try await runtime.performMutation { try await Task.sleep(for: .milliseconds(80)); return 1 } }
        await Task.yield()
        XCTAssertTrue(runtime.mutationRunning)
        do { _ = try await runtime.performMutation { 2 }; XCTFail("Overlapping update must be refused") } catch {}
        let firstValue = try await first.value
        XCTAssertEqual(firstValue, 1)
        XCTAssertFalse(runtime.mutationRunning)
        do { try await runtime.performMutation { throw LocalError.message("test") }; XCTFail("Expected error") } catch {}
        XCTAssertFalse(runtime.mutationRunning)
        let nextValue = try await runtime.performMutation { 3 }
        XCTAssertEqual(nextValue, 3)
    }
    @MainActor func testOnboardingNeverRegresses() async {
        let client = AgentKlarClient()
        client.adoptOnboarding(.object(["revision": .number(3), "mainHarness": .string("claude")]))
        client.adoptOnboarding(.object(["revision": .number(2), "mainHarness": .null]))
        XCTAssertEqual(client.onboarding["revision"].number, 3)
        XCTAssertEqual(client.onboarding["mainHarness"].string, "claude")
    }
    @MainActor func testNativeRequestBudgetsAndMaintenanceGate() async {
        XCTAssertEqual(AgentKlarClient.requestTimeout("/projects/id/skills/preview"), 135)
        XCTAssertEqual(AgentKlarClient.requestTimeout("/projects/id/plugins/apply"), 120)
        XCTAssertEqual(AgentKlarClient.requestTimeout("/projects/id/recommend"), 120)
        XCTAssertEqual(AgentKlarClient.requestTimeout("/projects/id/native-settings/claude"), 60)
        XCTAssertEqual(AgentKlarClient.requestTimeout("/snapshot"), 20)
        let client = AgentKlarClient()
        client.busy = true
        XCTAssertFalse(client.maintenanceReady)
        await client.updateService()
        XCTAssertEqual(client.error, "Finish the current local change before updating.")
        XCTAssertFalse(client.runtime.mutationRunning)
        client.busy = false
        XCTAssertTrue(client.maintenanceReady)
    }
    @MainActor func testProjectPictureNormalizesAndPreservesSavedImageOnRejectedInput() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        defer { try? FileManager.default.removeItem(at: directory) }
        // Use a bitmap directly so this fixture also works without a visible window.
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 640, pixelsHigh: 320,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        try XCTUnwrap(bitmap.bitmapData).initialize(repeating: 255, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
        let source = directory.appendingPathComponent("source.png")
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: source)
        let pictures = directory.appendingPathComponent("pictures"), id = UUID().uuidString
        let store = ProjectPictureStore(directory: pictures)
        try store.save(source, projectID: id)
        let hash = SHA256.hash(data: Data(id.lowercased().utf8)).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: pictures.path), [hash + ".png"])
        let savedURL = pictures.appendingPathComponent(hash + ".png"), saved = try Data(contentsOf: savedURL)
        XCTAssertEqual(Array(saved.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
        let native = try XCTUnwrap(CGImageSourceCreateWithData(saved as CFData, nil))
        let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(native, 0, nil) as? [CFString: Any])
        let width = try XCTUnwrap(properties[kCGImagePropertyPixelWidth] as? NSNumber).intValue
        let height = try XCTUnwrap(properties[kCGImagePropertyPixelHeight] as? NSNumber).intValue
        XCTAssertTrue((1...128).contains(width) && (1...128).contains(height))
        XCTAssertEqual(width, height * 2)
        let cached = ProjectPictureStore(directory: pictures)
        cached.load([id]); XCTAssertNotNil(cached.pictures[id])
        let original = try XCTUnwrap(store.pictures[id])
        let oversized = directory.appendingPathComponent("oversized.png")
        try Data(repeating: 0, count: 8 * 1024 * 1024 + 1).write(to: oversized)
        XCTAssertThrowsError(try store.save(oversized, projectID: id))
        XCTAssertEqual(try Data(contentsOf: savedURL), saved)
        XCTAssertThrowsError(try store.save(source, projectID: "../escape"))
        XCTAssertEqual(try Data(contentsOf: savedURL), saved)
        XCTAssertTrue(store.pictures[id] === original)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: pictures.path), [hash + ".png"])
        try store.remove(id)
        XCTAssertNil(store.pictures[id]); XCTAssertFalse(FileManager.default.fileExists(atPath: savedURL.path))
    }

    func testCommandBoundsTimeoutAndRetainedDescendantPipes() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let script = directory.appendingPathComponent("fixture.sh")
        try Data("sleep 30 &\necho $! > child.pid\nprintf done\nexit 0\n".utf8).write(to: script)
        let started = Date()
        let output = try await LocalRuntime.command(URL(fileURLWithPath: "/bin/sh"), args: [script.path], environment: ["PATH": "/usr/bin:/bin"], cwd: directory, timeout: 2)
        XCTAssertEqual(output, "done")
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        let child = Int32(try String(contentsOf: directory.appendingPathComponent("child.pid"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines))!
        XCTAssertEqual(kill(child, 0), -1)
        do {
            _ = try await LocalRuntime.command(URL(fileURLWithPath: "/bin/sh"), args: ["-c", "sleep 30"], environment: ["PATH": "/usr/bin:/bin"], cwd: directory, timeout: 0.1)
            XCTFail("Timeout must fail")
        } catch {}
    }

}
