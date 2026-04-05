// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "UITreeServer",
    platforms: [.iOS(.v16)],
    products: [
        .library(name: "UITreeServer", targets: ["UITreeServer"]),
    ],
    dependencies: [
        .package(url: "https://github.com/swhitty/FlyingFox.git", from: "0.16.0"),
        .package(path: "Logic"),
    ],
    targets: [
        .target(
            name: "UITreeServer",
            dependencies: ["FlyingFox", "UITreeLogic"],
            path: "UITests"
        ),
    ]
)
