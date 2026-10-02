// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "AgentKlarMac",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "AgentKlar", targets: ["AgentKlar"])],
    dependencies: [.package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.10.0")],
    targets: [
        .executableTarget(name: "AgentKlar", dependencies: [.product(name: "Sparkle", package: "Sparkle")],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]),
        .testTarget(name: "AgentKlarTests", dependencies: ["AgentKlar"]),
    ],
    swiftLanguageModes: [.v5]
)
