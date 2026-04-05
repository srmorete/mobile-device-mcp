import Foundation

/// Thread-safe counter using NSLock. Used to gate quiescence bypass:
/// when active (count > 0), XCUITest waits are short-circuited.
public final class AtomicCounter: @unchecked Sendable {
    private var _count = 0
    private let lock = NSLock()

    public init() {}

    public var isActive: Bool {
        lock.lock()
        defer { lock.unlock() }
        return _count > 0
    }

    public func increment() {
        lock.lock()
        defer { lock.unlock() }
        _count += 1
    }

    public func decrement() {
        lock.lock()
        defer { lock.unlock() }
        _count = max(_count - 1, 0)
    }
}
