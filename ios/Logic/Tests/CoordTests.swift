import XCTest
@testable import UITreeLogic

final class CoordTests: XCTestCase {

    func testComputeDownscaleLargeDevice() {
        // Android-style: 1080 x 2400 → 1500/2400 = 0.625
        let c = Coord.compute(nativeW: 1080, nativeH: 2400)
        XCTAssertEqual(c.renderScale, 0.625, accuracy: 1e-6)
    }

    func testComputeUpscaleIPhoneSE() {
        // iPhone SE: 375 x 667 points → 1500/667 ≈ 2.249
        let c = Coord.compute(nativeW: 375, nativeH: 667)
        XCTAssertEqual(c.renderScale, 1500.0 / 667.0, accuracy: 1e-6)
        XCTAssertGreaterThan(c.renderScale, 1.0)
    }

    func testComputeUpscaleIPhoneProMax() {
        // iPhone 15 Pro Max: 430 x 932 points → 1500/932 ≈ 1.609
        let c = Coord.compute(nativeW: 430, nativeH: 932)
        XCTAssertEqual(c.renderScale, 1500.0 / 932.0, accuracy: 1e-6)
        XCTAssertGreaterThan(c.renderScale, 1.0)
    }

    func testComputeRotationInvariantViaMax() {
        let portrait = Coord.compute(nativeW: 430, nativeH: 932)
        let landscape = Coord.compute(nativeW: 932, nativeH: 430)
        XCTAssertEqual(portrait.renderScale, landscape.renderScale)
    }

    func testComputeZeroDimsIdentity() {
        XCTAssertEqual(Coord.compute(nativeW: 0, nativeH: 0).renderScale, 1.0)
        XCTAssertEqual(Coord.compute(nativeW: 0, nativeH: 100).renderScale, 1.0)
        XCTAssertEqual(Coord.compute(nativeW: 100, nativeH: 0).renderScale, 1.0)
    }

    func testComputeExactlyAtTargetIsIdentity() {
        let c = Coord.compute(nativeW: 800, nativeH: 1500)
        XCTAssertEqual(c.renderScale, 1.0, accuracy: 1e-6)
    }

    func testToRenderToNativeRoundtripsExactly() {
        // Double precision: toNative(toRender(v)) == v bit-exact for finite scales.
        let scales = [0.625, 1500.0 / 667.0, 1500.0 / 932.0, 1.0, 0.3125]
        for scale in scales {
            let c = Coord(renderScale: scale)
            for n in stride(from: 0.0, through: 3000.0, by: 7.0) {
                let round = c.toNative(c.toRender(n))
                XCTAssertEqual(round, n, accuracy: 1e-9, "scale=\(scale) n=\(n)")
            }
        }
    }

    func testScaleRectAllComponents() {
        let c = Coord(renderScale: 2.0)
        let r = c.scaleRect(x: 10, y: 20, width: 30, height: 40)
        XCTAssertEqual(r.x, 20)
        XCTAssertEqual(r.y, 40)
        XCTAssertEqual(r.width, 60)
        XCTAssertEqual(r.height, 80)
    }
}
