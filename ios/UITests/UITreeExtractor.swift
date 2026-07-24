import XCTest
import CoreGraphics
import ImageIO
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
            return "Failed to encode screenshot"
        }
    }
}

final class UITreeExtractor {

    private let springboardHandle: AppHandle
    /// Single source of coordinate scaling — computed once from Springboard's frame
    /// because XCTest's UIScreen reports 320x480 regardless of the actual device.
    let coord: Coord

    init() {
        let sbHandle = Self.onMain {
            AppHandle(
                app: XCUIApplication(bundleIdentifier: "com.apple.springboard"),
                bundleId: "com.apple.springboard"
            )
        }
        self.springboardHandle = sbHandle
        self.coord = Self.computeInitialCoord(springboard: sbHandle.app)
        NSLog("[UITreeServer] renderScale=\(coord.renderScale) target=\(Coord.TARGET_LONG_EDGE)")
    }

    /// Run on the main thread, safe whether the caller is already on main or not —
    /// `DispatchQueue.main.sync` from main would deadlock.
    private static func onMain<T>(_ work: () -> T) -> T {
        Thread.isMainThread ? work() : DispatchQueue.main.sync(execute: work)
    }

    private static func computeInitialCoord(springboard: XCUIApplication) -> Coord {
        var result = Coord(renderScale: 1.0)
        onMain {
            var snapshot: XCUIElementSnapshot? = nil
            try? ObjCExceptionCatcher.catchException {
                snapshot = try? springboard.snapshot()
            }
            if let snap = snapshot, let frameValue = snap.dictionaryRepresentation[.frame] {
                let frame = FrameUtils.extractFrame(from: frameValue)
                result = Coord.compute(nativeW: frame.width, nativeH: frame.height)
            }
        }
        return result
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

            // Screen dimensions from first root node's frame (NOT screen API — reports 320x480).
            // Reported in render space to match all other endpoints.
            if let frameValue = dict[.frame] {
                let frame = FrameUtils.extractFrame(from: frameValue)
                screenWidth = coord.toRender(frame.width)
                screenHeight = coord.toRender(frame.height)
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

        // Frame — emitted in render space (single seam: Coord).
        if let frameValue = dict[.frame] {
            let frame = FrameUtils.extractFrame(from: frameValue)
            node["frame"] = [
                "x": coord.toRender(frame.x),
                "y": coord.toRender(frame.y),
                "width": coord.toRender(frame.width),
                "height": coord.toRender(frame.height),
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
            // XCUIScreen captures the display compositor output. XCUIApplication.screenshot()
            // returned stale cached renders on Springboard, causing screenshot/uitree drift.
            let screenshot = XCUIScreen.main.screenshot()

            // Render-space long edge in pixels. Aspect ratio is identical between logical
            // points and native pixels, so scaling the pixel dims to this bound lands on the
            // same target size as scaling point dims (within 1px rounding).
            let nativeSize = screenshot.image.size  // logical points
            let targetLongEdge = max(
                coord.toRender(Double(nativeSize.width)),
                coord.toRender(Double(nativeSize.height))
            ).rounded()

            // Full ImageIO pipeline: decode -> purpose-built thumbnail downscaler -> JPEG
            // encode. CGImageSourceCreateThumbnailAtIndex is ~2-3x faster than the old
            // UIGraphicsImageRenderer + draw(in:) CGContext round-trip (issue #5).
            let pngData = screenshot.pngRepresentation
            guard let source = CGImageSourceCreateWithData(pngData as CFData, nil) else {
                throw UITreeError.screenshotEncodingFailed
            }

            let thumbOptions: [CFString: Any] = [
                // Decode from the original, never from a cached/incorrect thumbnail.
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: targetLongEdge,
            ]
            guard let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else {
                throw UITreeError.screenshotEncodingFailed
            }

            let jpegData = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(
                jpegData, "public.jpeg" as CFString, 1, nil
            ) else {
                throw UITreeError.screenshotEncodingFailed
            }
            CGImageDestinationAddImage(destination, thumbnail, [
                kCGImageDestinationLossyCompressionQuality: 0.75,
            ] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else {
                throw UITreeError.screenshotEncodingFailed
            }
            return jpegData as Data
        }
    }
}
