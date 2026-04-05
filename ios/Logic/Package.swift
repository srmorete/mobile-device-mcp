// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UITreeLogic",
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "UITreeLogic", targets: ["UITreeLogic"]),
    ],
    targets: [
        .target(name: "UITreeLogic", path: "Sources"),
        .testTarget(name: "UITreeLogicTests", dependencies: ["UITreeLogic"], path: "Tests"),
    ]
)
