import SwiftUI
import AppKit
import CryptoKit
import ImageIO
import UniformTypeIdentifiers
import Darwin

@MainActor final class ProjectPictureStore: ObservableObject {
    @Published private(set) var pictures: [String: NSImage] = [:]
    private var loaded: Set<String> = []
    private let directory: URL
    private static let maximumBytes = 8 * 1024 * 1024

    init(directory: URL? = nil) {
        self.directory = directory ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("AgentKlar/project-pictures", isDirectory: true)
    }
    func load(_ ids: [String]) {
        for id in ids where !loaded.contains(id) {
            loaded.insert(id)
            guard let url = try? location(id), let data = try? read(url, limit: 256 * 1024),
                  let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let width = properties[kCGImagePropertyPixelWidth] as? NSNumber, let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
                  (1...128).contains(width.intValue), (1...128).contains(height.intValue),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { continue }
            pictures[id] = NSImage(cgImage: image, size: NSSize(width: CGFloat(image.width), height: CGFloat(image.height)))
        }
    }
    func save(_ source: URL, projectID: String) throws {
        let access = source.startAccessingSecurityScopedResource()
        defer { if access { source.stopAccessingSecurityScopedResource() } }
        let data = try read(source, limit: Self.maximumBytes)
        guard let imageSource = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0, width.doubleValue <= 16384, height.doubleValue <= 16384,
              width.doubleValue * height.doubleValue <= 40_000_000,
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(imageSource, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: 128,
                kCGImageSourceShouldCacheImmediately: true,
              ] as CFDictionary) else { throw LocalError.message("Choose an image up to 8 MiB and 40 million pixels, with sides no larger than 16,384 pixels.") }
        let encoded = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(encoded, UTType.png.identifier as CFString, 1, nil) else { throw LocalError.message("The project picture could not be prepared.") }
        CGImageDestinationAddImage(destination, thumbnail, nil)
        guard CGImageDestinationFinalize(destination), encoded.length <= 256 * 1024 else { throw LocalError.message("The project picture could not be prepared.") }
        let target = try location(projectID)
        try prepareDirectory()
        try Data(referencing: encoded).write(to: target, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
        pictures[projectID] = NSImage(cgImage: thumbnail, size: NSSize(width: CGFloat(thumbnail.width), height: CGFloat(thumbnail.height)))
        loaded.insert(projectID)
    }
    func remove(_ projectID: String) throws {
        let target = try location(projectID)
        if FileManager.default.fileExists(atPath: target.path) { try FileManager.default.removeItem(at: target) }
        pictures.removeValue(forKey: projectID); loaded.insert(projectID)
    }
    private func location(_ id: String) throws -> URL {
        guard let uuid = UUID(uuidString: id) else { throw LocalError.message("Choose a saved project before adding a picture.") }
        let hash = SHA256.hash(data: Data(uuid.uuidString.lowercased().utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(hash + ".png")
    }
    private func prepareDirectory() throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let values = try directory.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        guard values.isDirectory == true, values.isSymbolicLink != true,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid() else { throw LocalError.message("The local project picture folder is not owned by this user.") }
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
    }
    private func read(_ url: URL, limit: Int) throws -> Data {
        let values = try url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard values.isRegularFile == true, let size = values.fileSize, size > 0, size <= limit else { throw LocalError.message("Choose a regular image file no larger than 8 MiB.") }
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: limit + 1) ?? Data()
        guard !data.isEmpty, data.count <= limit else { throw LocalError.message("The image exceeds the size limit.") }
        return data
    }
}

struct NativeProjectAvatar: View {
    let projectID: String
    let name: String
    @ObservedObject var store: ProjectPictureStore
    var size: CGFloat = 32
    private var initials: String {
        let words = name.split(whereSeparator: { $0.isWhitespace })
        let value = words.prefix(2).compactMap(\.first).map { String($0) }.joined().uppercased()
        return value.isEmpty ? "P" : value
    }
    private var color: Color {
        let palette: [Color] = [.blue, .purple, .teal, .indigo, .orange, .pink, .green]
        return palette[Int(Array(SHA256.hash(data: Data(projectID.utf8))).first ?? 0) % palette.count]
    }
    var body: some View {
        Group {
            if let picture = store.pictures[projectID] { Image(nsImage: picture).resizable().scaledToFill() }
            else { RoundedRectangle(cornerRadius: 7).fill(color.opacity(0.15)).overlay { Text(initials).font(.system(size: size * 0.36, weight: .semibold)).foregroundStyle(color) } }
        }.frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: 7)).accessibilityHidden(true)
    }
}
