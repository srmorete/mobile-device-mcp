import XCTest
import CoreGraphics
import UIKit
#if canImport(UITreeLogic)
import UITreeLogic
#endif

/// Tracks an XCUIApplication paired with its bundle ID since
/// XCUIApplication doesn't publicly expose the identifier after init.
struct AppHandle {
    let app: XCUIApplication
    let bundleId: String
}

enum UITreeError: LocalizedError {
    case snapshotFailed
    case screenshotEncodingFailed

    var errorDescription: String? {
        switch self {
        case .snapshotFailed:
            return "Failed to capture app snapshot"
        case .screenshotEncodingFailed:
            return "Failed to encode screenshot as PNG"
        }
    }
}

final class UITreeExtractor {

    private let springboardHandle: AppHandle

    init() {
        springboardHandle = DispatchQueue.main.sync {
            let sb = XCUIApplication(bundleIdentifier: "com.apple.springboard")

            return AppHandle(app: sb, bundleId: "com.apple.springboard")
        }
    }

    // MARK: - Foreground App Detection

    /// Find the current foreground app, excluding Springboard.
    /// Falls back to Springboard if none.
    func foregroundApp() -> AppHandle {
        // XCUIDevice.shared → accessibilityInterface (XCAXClient_iOS)
        //   → activeForegroundApplications → [XCUIApplication]
        let device = XCUIDevice.shared
        let axSel = NSSelectorFromString("accessibilityInterface")
        if device.responds(to: axSel),
           let axClient = device.perform(axSel)?.takeUnretainedValue() as? NSObject
        {
            let fgSel = NSSelectorFromString("activeForegroundApplications")
            if axClient.responds(to: fgSel),
               let fgApps = axClient.perform(fgSel)?.takeUnretainedValue() as? [XCUIApplication]
            {
                for app in fgApps {
                    let bundleId = extractBundleId(from: app)
                    if !bundleId.isEmpty && bundleId != "com.apple.springboard" {
                        return AppHandle(app: app, bundleId: bundleId)
                    }
                }
            }
        }

        return springboardHandle
    }

    /// Extract bundle identifier from XCUIApplication via private API.
    private func extractBundleId(from app: XCUIApplication) -> String {
        let sel = NSSelectorFromString("bundleID")
        if app.responds(to: sel),
           let bid = app.perform(sel)?.takeUnretainedValue() as? String {
            return bid
        }
        let sel2 = NSSelectorFromString("_bundleID")
        if app.responds(to: sel2),
           let bid = app.perform(sel2)?.takeUnretainedValue() as? String {
            return bid
        }
        return ""
    }

    // MARK: - UI Tree Capture

    func captureUITree() throws -> [String: Any] {
        return try DispatchQueue.main.sync {
            let handle = foregroundApp()
            let app = handle.app
            let appBundleId = handle.bundleId

            var nodes: [[String: Any]] = []
            var screenWidth: Double = 0
            var screenHeight: Double = 0

            // snapshot() can throw ObjC NSExceptions (e.g. on complex web content trees)
            // that bypass Swift's try?/do-catch. Wrap in ObjCExceptionCatcher.
            var snapshot: XCUIElementSnapshot? = nil
            try ObjCExceptionCatcher.catchException {
                snapshot = try? app.snapshot()
            }
            guard let snapshot else {
                throw UITreeError.snapshotFailed
            }

            let dict = snapshot.dictionaryRepresentation
            let rootNode = buildNode(from: dict)
            nodes.append(rootNode)

            // Screen dimensions from first root node's frame.
            // Per spec: NOT from screen API (reports 320x480).
            if let frameValue = dict[.frame] {
                let frame = FrameUtils.extractFrame(from: frameValue)
                screenWidth = frame.width
                screenHeight = frame.height
            }

            // Always include status bar elements from Springboard
            if appBundleId != "com.apple.springboard" {
                appendStatusBarNodes(to: &nodes)
            }

            // Include Safari WebView service UI tree if Safari is in foreground.
            // Wrapped in ObjCExceptionCatcher: WebKit.WebContent snapshot can throw
            // NSExceptions on complex pages. Failure here is non-fatal — we still
            // return the main app tree + status bar.
            if appBundleId == "com.apple.mobilesafari" {
                try? ObjCExceptionCatcher.catchException {
                    let webContent = XCUIApplication(bundleIdentifier: "com.apple.WebKit.WebContent")
                    if webContent.state == .runningForeground {
                        if let webSnapshot = try? webContent.snapshot() {
                            nodes.append(self.buildNode(from: webSnapshot.dictionaryRepresentation))
                        }
                    }
                }
            }

            return [
                "screenWidth": screenWidth,
                "screenHeight": screenHeight,
                "nodes": nodes,
            ]
        }
    }

    // MARK: - Status Bar

    private func appendStatusBarNodes(to nodes: inout [[String: Any]]) {
        var sbSnapshot: XCUIElementSnapshot? = nil
        try? ObjCExceptionCatcher.catchException {
            sbSnapshot = try? self.springboardHandle.app.snapshot()
        }
        guard let sbSnapshot else { return }
        let sbDict = sbSnapshot.dictionaryRepresentation

        guard let childrenValue = sbDict[.children],
              let childDicts = childrenValue as? [[XCUIElement.AttributeName: Any]] else {
            return
        }

        var foundStatusBar = false
        for child in childDicts {
            let elementTypeRaw = child[.elementType] as? Int ?? 0
            let label = child[.label] as? String ?? ""
            let identifier = child[.identifier] as? String ?? ""
            // Status bar: type 38 (statusBar), or identifier/label contains StatusBar
            if identifier.contains("StatusBar") || label.contains("StatusBar")
                || elementTypeRaw == 38 {
                nodes.append(buildNode(from: child))
                foundStatusBar = true
            }
        }

        // If nothing found by identifier, the first child is usually the status bar window
        if !foundStatusBar, let first = childDicts.first {
            if let subChildrenValue = first[.children],
               let subChildren = subChildrenValue as? [[XCUIElement.AttributeName: Any]] {
                for child in subChildren {
                    nodes.append(buildNode(from: child))
                }
            }
        }
    }

    // MARK: - Snapshot Node Building

    /// Convert an accessibility snapshot dictionary to the JSON node format.
    func buildNode(from dict: [XCUIElement.AttributeName: Any]) -> [String: Any] {
        var node: [String: Any] = [:]

        node["identifier"] = (dict[.identifier] as? String) ?? ""
        node["label"] = (dict[.label] as? String) ?? ""

        // Optional fields -- only include if non-nil
        if let title = dict[.title] as? String {
            node["title"] = title
        }
        if let value = dict[.value] as? String {
            node["value"] = value
        } else if let value = dict[.value] {
            node["value"] = "\(value)"
        }
        if let placeholder = dict[.placeholderValue] as? String {
            node["placeholderValue"] = placeholder
        }

        // Element type (raw integer)
        let elementTypeRaw = (dict[.elementType] as? UInt) ?? 0
        node["elementType"] = elementTypeRaw

        // Frame
        if let frameValue = dict[.frame] {
            let frame = FrameUtils.extractFrame(from: frameValue)
            node["frame"] = [
                "x": frame.x,
                "y": frame.y,
                "width": frame.width,
                "height": frame.height,
            ]
        } else {
            node["frame"] = [
                "x": 0.0,
                "y": 0.0,
                "width": 0.0,
                "height": 0.0,
            ]
        }

        // Boolean properties
        node["enabled"] = (dict[.enabled] as? Bool) ?? true
        node["selected"] = (dict[.selected] as? Bool) ?? false
        node["hasFocus"] = (dict[.hasFocus] as? Bool) ?? false

        // Children -- recursively build
        if let childrenValue = dict[.children],
           let childDicts = childrenValue as? [[XCUIElement.AttributeName: Any]] {
            node["children"] = childDicts.map { buildNode(from: $0) }
        }

        return node
    }

    // MARK: - Screenshot Capture

    func captureScreenshot() throws -> Data {
        return try DispatchQueue.main.sync {
            let handle = foregroundApp()
            let screenshot = handle.app.screenshot()
            let fullImage = screenshot.image

            // Re-render at 1x scale so pixel coords match UI tree frame coords.
            // The raw screenshot is captured at native pixel scale (e.g. 3x).
            let size = fullImage.size  // Already in points
            let format = UIGraphicsImageRendererFormat()
            format.scale = 1.0
            let renderer = UIGraphicsImageRenderer(size: size, format: format)
            let image1x = renderer.image { _ in
                fullImage.draw(in: CGRect(origin: .zero, size: size))
            }

            guard let jpegData = image1x.jpegData(compressionQuality: 0.80) else {
                throw UITreeError.screenshotEncodingFailed
            }
            return jpegData
        }
    }
}
