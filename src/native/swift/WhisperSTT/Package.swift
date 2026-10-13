// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "WhisperSTT",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "whisperstt", targets: ["WhisperSTT"])
    ],
    dependencies: [
        .package(url: "https://github.com/argmaxinc/WhisperKit.git", from: "0.9.0")
    ],
    targets: [
        .executableTarget(
            name: "WhisperSTT",
            dependencies: [
                .product(name: "WhisperKit", package: "WhisperKit")
            ],
            path: "Sources/WhisperSTT"
        )
    ]
)
