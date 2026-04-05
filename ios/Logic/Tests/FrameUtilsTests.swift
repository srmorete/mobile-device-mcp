import XCTest
import CoreGraphics
@testable import UITreeLogic

final class FrameUtilsTests: XCTestCase {

    func testCGRectInput() {
        let rect = CGRect(x: 10, y: 20, width: 100, height: 50)
        let frame = FrameUtils.extractFrame(from: rect)
        XCTAssertEqual(frame.x, 10)
        XCTAssertEqual(frame.y, 20)
        XCTAssertEqual(frame.width, 100)
        XCTAssertEqual(frame.height, 50)
    }

    func testNSValueWrappingCGRect() {
        let rect = CGRect(x: 5, y: 15, width: 200, height: 300)
        #if canImport(UIKit)
        let nsValue = NSValue(cgRect: rect)
        #else
        let nsValue = NSValue(rect: rect)
        #endif
        let frame = FrameUtils.extractFrame(from: nsValue)
        XCTAssertEqual(frame.x, 5)
        XCTAssertEqual(frame.y, 15)
        XCTAssertEqual(frame.width, 200)
        XCTAssertEqual(frame.height, 300)
    }

    func testDictionaryInput() {
        let dict: [String: Double] = ["X": 30, "Y": 40, "Width": 150, "Height": 60]
        let frame = FrameUtils.extractFrame(from: dict)
        XCTAssertEqual(frame.x, 30)
        XCTAssertEqual(frame.y, 40)
        XCTAssertEqual(frame.width, 150)
        XCTAssertEqual(frame.height, 60)
    }

    func testDictionaryMissingKeysDefaultToZero() {
        let dict: [String: Double] = ["X": 10]
        let frame = FrameUtils.extractFrame(from: dict)
        XCTAssertEqual(frame.x, 10)
        XCTAssertEqual(frame.y, 0)
        XCTAssertEqual(frame.width, 0)
        XCTAssertEqual(frame.height, 0)
    }

    func testUnknownTypeReturnsAllZeros() {
        let frame = FrameUtils.extractFrame(from: "not a frame")
        XCTAssertEqual(frame.x, 0)
        XCTAssertEqual(frame.y, 0)
        XCTAssertEqual(frame.width, 0)
        XCTAssertEqual(frame.height, 0)
    }

    func testNegativeValuesPreserved() {
        let rect = CGRect(x: -10, y: -20, width: 100, height: 50)
        let frame = FrameUtils.extractFrame(from: rect)
        XCTAssertEqual(frame.x, -10)
        XCTAssertEqual(frame.y, -20)
    }
}
