import XCTest

enum InteractionError: LocalizedError {
    case textInputUnavailable

    var errorDescription: String? {
        switch self {
        case .textInputUnavailable:
            return "typeText failed: no foreground app found"
        }
    }
}

final class Interactions {

    // Springboard coordinate space for absolute screen positions.
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private let extractor: UITreeExtractor

    init(extractor: UITreeExtractor) {
        self.extractor = extractor
    }

    private func coord(x: Double, y: Double) -> XCUICoordinate {
        springboard.coordinate(
            withNormalizedOffset: CGVector(dx: 0, dy: 0)
        ).withOffset(CGVector(dx: x, dy: y))
    }

    func tap(x: Double, y: Double) {
        DispatchQueue.main.sync { coord(x: x, y: y).tap() }
    }

    func doubleTap(x: Double, y: Double) {
        DispatchQueue.main.sync { coord(x: x, y: y).doubleTap() }
    }

    func longPress(x: Double, y: Double, durationMs: Double) {
        DispatchQueue.main.sync { coord(x: x, y: y).press(forDuration: durationMs / 1000.0) }
    }

    func scroll(startX: Double, startY: Double, endX: Double, endY: Double) {
        DispatchQueue.main.sync {
            coord(x: startX, y: startY).press(
                forDuration: 0.1, thenDragTo: coord(x: endX, y: endY)
            )
        }
    }

    // MARK: - Type Text

    /// Types text into the currently focused field of the foreground app.
    func typeText(_ text: String) throws {
        try DispatchQueue.main.sync {
            let handle = extractor.foregroundApp()
            if handle.bundleId == "com.apple.springboard" {
                throw InteractionError.textInputUnavailable
            }
            try ObjCExceptionCatcher.catchException {
                handle.app.typeText(text)
            }
        }
    }

    // MARK: - Press Button

    func pressHome() {
        DispatchQueue.main.sync { XCUIDevice.shared.press(.home) }
    }
}
