import CoreGraphics
import Foundation

/// Single source of coordinate calculation between native logical points and render space.
///
/// Render space is the unified coordinate system exposed by all server endpoints:
/// screenshot pixel dims, UI tree frames, and /tap /scroll /longPress inputs.
/// Conversion to native happens at the handler edge before dispatch to XCUITest.
///
/// `renderScale = TARGET_LONG_EDGE / max(nativeWidth, nativeHeight)`
/// `max()` makes the scale rotation-invariant. Zero/unknown dims yield identity (1.0).
/// iOS native dims (logical points) are always below `TARGET_LONG_EDGE`, so this always
/// upscales — the screenshot capture is still sourced from native pixel density, so the
/// render pipeline super-samples from a sharper original on retina devices.
public struct Coord: Sendable {

    /// Longer-side target in render pixels. Keeps images below the 1568 vision
    /// resize threshold and the 2000 per-dimension many-image cap.
    public static let TARGET_LONG_EDGE: Double = 1500

    public let renderScale: Double

    public init(renderScale: Double) {
        self.renderScale = renderScale
    }

    public static func compute(nativeW: Double, nativeH: Double) -> Coord {
        // Identity if either dim is missing/invalid — avoids a misleading scale
        // derived from only one known side.
        guard nativeW > 0, nativeH > 0 else { return Coord(renderScale: 1.0) }
        return Coord(renderScale: TARGET_LONG_EDGE / max(nativeW, nativeH))
    }

    public func toRender(_ v: Double) -> Double { v * renderScale }
    public func toNative(_ v: Double) -> Double { v / renderScale }

    public func scaleRect(x: Double, y: Double, width: Double, height: Double) -> (x: Double, y: Double, width: Double, height: Double) {
        (toRender(x), toRender(y), toRender(width), toRender(height))
    }
}
