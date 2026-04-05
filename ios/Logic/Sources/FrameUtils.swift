import CoreGraphics
import Foundation

/// Extracts frame components from various representations returned by
/// XCUIElementSnapshot's dictionaryRepresentation.
public enum FrameUtils {

    /// Extract (x, y, width, height) from a frame value that may be:
    /// - CGRect
    /// - NSValue wrapping CGRect
    /// - Dictionary with X/Y/Width/Height keys
    public static func extractFrame(from frameValue: Any) -> (x: Double, y: Double, width: Double, height: Double) {
        if let rect = frameValue as? CGRect {
            return (Double(rect.origin.x), Double(rect.origin.y),
                    Double(rect.size.width), Double(rect.size.height))
        }
        if let nsValue = frameValue as? NSValue {
            #if canImport(UIKit)
            let rect = nsValue.cgRectValue
            #else
            let rect = nsValue.rectValue
            #endif
            return (Double(rect.origin.x), Double(rect.origin.y),
                    Double(rect.size.width), Double(rect.size.height))
        }
        if let dict = frameValue as? [String: Double] {
            return (dict["X"] ?? 0, dict["Y"] ?? 0, dict["Width"] ?? 0, dict["Height"] ?? 0)
        }
        return (0, 0, 0, 0)
    }
}
