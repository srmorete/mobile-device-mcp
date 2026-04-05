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

    private static let _swizzle: Void = {
        // No-op void methods when bypass is active
        func swizzleVoid(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = class_getInstanceMethod(cls, sel) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject) -> Void = { obj in
                guard !skipQuiescence.isActive else { return }
                unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector) -> Void).self)(obj, sel)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }
        // No-op void(Bool) methods
        func swizzleVoidBool(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = class_getInstanceMethod(cls, sel) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject, Bool) -> Void = { obj, arg in
                guard !skipQuiescence.isActive else { return }
                unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector, Bool) -> Void).self)(obj, sel, arg)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }
        // Short-circuit Bool(Double) waits to return true immediately
        func swizzleWait(_ cls: AnyClass, _ selName: String) {
            let sel = NSSelectorFromString(selName)
            guard let m = class_getInstanceMethod(cls, sel) else { return }
            let orig = method_getImplementation(m)
            let block: @convention(block) (AnyObject, Double) -> Bool = { obj, timeout in
                guard !skipQuiescence.isActive else { return true }
                return unsafeBitCast(orig, to: (@convention(c) (AnyObject, Selector, Double) -> Bool).self)(obj, sel, timeout)
            }
            method_setImplementation(m, imp_implementationWithBlock(block))
        }

        let app = XCUIApplication.self as AnyClass
        let elem = XCUIElement.self as AnyClass

        // XCUIApplication quiescence
        swizzleVoid(app, "_waitForQuiescence")
        swizzleVoidBool(app, "_waitForQuiescenceAsPreEvent:")

        // XCUIElement waits that block on app quiescence
        swizzleWait(elem, "_waitForExistenceWithTimeout:")
        swizzleWait(elem, "_waitForHittableWithTimeout:")
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
