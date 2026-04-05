import XCTest
@testable import UITreeLogic

final class AtomicCounterTests: XCTestCase {

    func testInitialStateIsInactive() {
        let counter = AtomicCounter()
        XCTAssertFalse(counter.isActive)
    }

    func testIncrementMakesActive() {
        let counter = AtomicCounter()
        counter.increment()
        XCTAssertTrue(counter.isActive)
    }

    func testIncrementAndDecrementMakesInactive() {
        let counter = AtomicCounter()
        counter.increment()
        counter.decrement()
        XCTAssertFalse(counter.isActive)
    }

    func testDecrementBelowZeroStaysInactive() {
        let counter = AtomicCounter()
        counter.decrement()
        counter.decrement()
        XCTAssertFalse(counter.isActive)
    }

    func testMultipleIncrementsRequireMatchingDecrements() {
        let counter = AtomicCounter()
        counter.increment()
        counter.increment()
        counter.increment()
        counter.decrement()
        XCTAssertTrue(counter.isActive)
        counter.decrement()
        XCTAssertTrue(counter.isActive)
        counter.decrement()
        XCTAssertFalse(counter.isActive)
    }

    func testConcurrentAccess() {
        let counter = AtomicCounter()
        let iterations = 1000
        let group = DispatchGroup()

        // Increment from many threads
        for _ in 0..<iterations {
            group.enter()
            DispatchQueue.global().async {
                counter.increment()
                group.leave()
            }
        }
        group.wait()
        XCTAssertTrue(counter.isActive)

        // Decrement from many threads
        for _ in 0..<iterations {
            group.enter()
            DispatchQueue.global().async {
                counter.decrement()
                group.leave()
            }
        }
        group.wait()
        XCTAssertFalse(counter.isActive)
    }
}
