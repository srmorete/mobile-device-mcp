import XCTest
import Foundation
import ObjectiveC
#if canImport(UITreeLogic)
import UITreeLogic
#endif

final class AppManager {

    // MARK: - Launch App

    func launchApp(bundleId: String) {
        DispatchQueue.main.sync {
            let app = XCUIApplication(bundleIdentifier: bundleId)

            app.launch()
        }
    }

    // MARK: - Terminate App

    func terminateApp(bundleId: String) {
        DispatchQueue.main.sync {
            let app = XCUIApplication(bundleIdentifier: bundleId)

            app.terminate()
        }
    }

    static let skipQuiescence = AtomicCounter()

    static func installQuiescenceBypass() {
        _ = _swizzle
    }

    /// Unbuffered stderr diag — lands in the host-side log file.
    static func diag(_ message: String) {
        FileHandle.standardError.write(Data("[UITreeServer] \(message)\n".utf8))
    }

    /// First-hit-only log so we can see which waits the bypass actually
    /// suppresses without flooding the log on a busy app.
    /// Swizzled IMPs fire on arbitrary XCTest threads — the Set must be
    /// locked (same pattern as AtomicCounter / JsEngine.lastForeground).
    private static var suppressedLogged = Set<String>()
    private static let suppressedLoggedLock = NSLock()
    static func logSuppressed(_ selName: String) {
        suppressedLoggedLock.lock()
        let isNew = suppressedLogged.insert(selName).inserted
        suppressedLoggedLock.unlock()
        if isNew {
            diag("quiescence bypass suppressed: \(selName)")
        }
    }

    private static let _swizzle: Void = {
        // Install bookkeeping: missing selectors must be visible in the log —
        // a silent no-op swizzle cost us a full debug cycle (issue #15).
        func findMethod(_ cls: AnyClass, _ selName: String) -> Method? {
            let sel = NSSelectorFromString(selName)
            guard let m = class_getInstanceMethod(cls, sel) else {
                diag("quiescence bypass: MISSING \(selName) on \(cls)")
                return nil
            }
            diag("quiescence bypass: installed \(selName) on \(cls)")
            return m
        }
        // No-op void methods when bypass is active
        func swizzleVoid(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = findMethod(cls, selName) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject) -> Void = { obj in
                guard !skipQuiescence.isActive else { logSuppressed(selName); return }
                unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector) -> Void).self)(obj, sel)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }
        // No-op void(Bool) methods
        func swizzleVoidBool(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = findMethod(cls, selName) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject, Bool) -> Void = { obj, arg in
                guard !skipQuiescence.isActive else { logSuppressed(selName); return }
                unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector, Bool) -> Void).self)(obj, sel, arg)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }
        // Bool-returning getters short-circuited to true (quiescence skip flags)
        func swizzleBoolGetterTrue(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = findMethod(cls, selName) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject) -> Bool = { obj in
                guard !skipQuiescence.isActive else { logSuppressed(selName); return true }
                return unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector) -> Bool).self)(obj, sel)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }
        // Short-circuit Bool(Double) waits to return true immediately
        func swizzleWait(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = findMethod(cls, selName) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject, Double) -> Bool = { obj, timeout in
                guard !skipQuiescence.isActive else { logSuppressed(selName); return true }
                return unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector, Double) -> Bool).self)(obj, sel, timeout)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }
        // No-op void(Bool, Bool) methods
        func swizzleVoidBool2(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = findMethod(cls, selName) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject, Bool, Bool) -> Void = { obj, a, b in
                guard !skipQuiescence.isActive else { logSuppressed(selName); return }
                unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector, Bool, Bool) -> Void).self)(obj, sel, a, b)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }
        // No-op void(Bool, AnyObject, Bool) methods
        func swizzleVoidBoolObjBool(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = findMethod(cls, selName) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject, Bool, AnyObject, Bool) -> Void = { obj, a, activity, b in
                guard !skipQuiescence.isActive else { logSuppressed(selName); return }
                unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector, Bool, AnyObject, Bool) -> Void).self)(obj, sel, a, activity, b)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }

        let app = XCUIApplication.self as AnyClass
        let elem = XCUIElement.self as AnyClass

        // XCUIApplication quiescence
        swizzleVoid(app, "_waitForQuiescence")
        swizzleVoidBool(app, "_waitForQuiescenceAsPreEvent:")

        // XCUIElement quiescence + waits that block on app quiescence
        swizzleVoid(elem, "_waitForQuiescence")
        swizzleVoidBool(elem, "_waitForQuiescenceAsPreEvent:")
        swizzleWait(elem, "_waitForExistenceWithTimeout:")
        swizzleWait(elem, "_waitForHittableWithTimeout:")

        // The snapshot path waits for quiescence on XCUIApplicationProcess, NOT
        // on XCUIApplication (issue #15): the first snapshot of a busy process
        // (e.g. Safari's WebKit.WebContent) blocked here for exactly 60s until
        // XCTest's internal quiescence timeout elapsed.
        if let proc = NSClassFromString("XCUIApplicationProcess") {
            swizzleVoidBool2(proc, "waitForQuiescenceIncludingAnimationsIdle:isPreEvent:")
            swizzleVoidBoolObjBool(proc, "waitForQuiescenceIncludingAnimationsIdle:usingActivity:isPreEvent:")
            // XCTest's own skip flags + check initiator — cover every entry
            // point into the 60s quiescence wait (issue #15).
            swizzleBoolGetterTrue(proc, "shouldSkipPreEventQuiescence")
            swizzleBoolGetterTrue(proc, "shouldSkipPostEventQuiescence")
            swizzleVoidBool(proc, "_initiateQuiescenceChecksIncludingAnimationsIdle:")
        } else {
            diag("quiescence bypass: XCUIApplicationProcess class NOT FOUND")
        }
        if let axClient = NSClassFromString("XCAXClient_iOS") {
            swizzleVoidBool(axClient, "waitForQuiescenceOnAllForegroundApplicationsAsPreEvent:")
        } else {
            diag("quiescence bypass: XCAXClient_iOS class NOT FOUND")
        }
    }()

    // MARK: - List Apps

    /// Returns a sorted array of installed bundle IDs using the device's
    /// application workspace API (dynamically loaded).
    func listApps() -> [String] {
        // Dynamically load LSApplicationWorkspace to enumerate installed apps.
        // This is a private API available on device / simulator.
        guard let lsClass = NSClassFromString("LSApplicationWorkspace") else {
            return []
        }

        let selector = NSSelectorFromString("defaultWorkspace")
        guard let workspace = (lsClass as AnyObject).perform(selector)?.takeUnretainedValue() else {
            return []
        }

        let appsSelector = NSSelectorFromString("allInstalledApplications")
        guard let allApps = workspace.perform(appsSelector)?.takeUnretainedValue() as? [AnyObject] else {
            return []
        }

        let bundleIdSelector = NSSelectorFromString("applicationIdentifier")
        var bundleIds: [String] = []
        for proxy in allApps {
            if let bid = proxy.perform(bundleIdSelector)?.takeUnretainedValue() as? String {
                bundleIds.append(bid)
            }
        }

        // Sort case-insensitively
        bundleIds.sort { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        return bundleIds
    }
}
