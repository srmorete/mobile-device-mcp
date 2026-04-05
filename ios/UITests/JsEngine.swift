import Foundation
import JavaScriptCore
import XCTest

struct JsResult {
    let dict: [String: Any]
    let isError: Bool
}

final class JsEngine {

    private let extractor: UITreeExtractor

    init(extractor: UITreeExtractor) {
        self.extractor = extractor
    }

    // MARK: - Execute JavaScript

    func execute(code: String) -> JsResult {
        let context = JSContext()!
        var logs: [String] = []
        var jsError: String? = nil

        // Install exception handler
        context.exceptionHandler = { _, exception in
            jsError = exception?.toString() ?? "Unknown JS error"
        }

        // Install console
        let consoleObj = JSValue(newObjectIn: context)!
        let logFn: @convention(block) () -> Void = {
            let args = JSContext.currentArguments() as? [JSValue] ?? []
            let line = args.map { $0.toString() ?? "" }.joined(separator: " ")
            logs.append(line)
        }
        consoleObj.setObject(logFn, forKeyedSubscript: "log" as NSString)
        consoleObj.setObject(logFn, forKeyedSubscript: "warn" as NSString)
        consoleObj.setObject(logFn, forKeyedSubscript: "error" as NSString)
        context.setObject(consoleObj, forKeyedSubscript: "console" as NSString)

        // Install sleep(ms) — capped at 30s to prevent indefinite thread blocking
        let sleepFn: @convention(block) (Int) -> Void = { ms in
            let clamped = min(max(ms, 0), 30_000)
            Thread.sleep(forTimeInterval: Double(clamped) / 1000.0)
        }
        context.setObject(sleepFn, forKeyedSubscript: "sleep" as NSString)

        // Install device
        let deviceObj = JSValue(newObjectIn: context)!
        let pressHomeFn: @convention(block) () -> Void = {
            DispatchQueue.main.sync { XCUIDevice.shared.press(.home) }
        }
        deviceObj.setObject(pressHomeFn, forKeyedSubscript: "pressHome" as NSString)

        let orientationFn: @convention(block) () -> Int = {
            return DispatchQueue.main.sync { Int(XCUIDevice.shared.orientation.rawValue) }
        }
        deviceObj.setObject(orientationFn, forKeyedSubscript: "orientation" as NSString)

        context.setObject(deviceObj, forKeyedSubscript: "device" as NSString)

        // Install openApp(bundleId)
        let openAppFn: @convention(block) (String) -> JSValue = { [weak self] bundleId in
            let app = XCUIApplication(bundleIdentifier: bundleId)
            DispatchQueue.main.sync { app.launch() }
            guard let raw = self?.wrapApp(app, bundleId: bundleId, in: context) else {
                return JSValue(undefinedIn: context)!
            }
            // Proxy-wrap so bracket notation works on the returned app
            return context.evaluateScript("_createProxy")?.call(withArguments: [raw]) ?? raw
        }
        context.setObject(openAppFn, forKeyedSubscript: "openApp" as NSString)

        // Bypass quiescence waits for the entire exec call
        AppManager.skipQuiescence.increment()
        defer { AppManager.skipQuiescence.decrement() }

        // Resolve foreground app with a timeout — XCUITest can block indefinitely
        // on quiescence waits when the foreground app is busy (e.g., Safari loading).
        let foregroundHandle = Self.resolveForeground(extractor: extractor)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

        let appWrapper = wrapApp(
            foregroundHandle.app, bundleId: foregroundHandle.bundleId, in: context
        )
        let sbWrapper = wrapApp(
            springboard, bundleId: "com.apple.springboard", in: context
        )

        context.setObject(appWrapper, forKeyedSubscript: "app" as NSString)
        context.setObject(sbWrapper, forKeyedSubscript: "springboard" as NSString)

        // Install the Proxy shim for bracket-access
        installProxyShim(in: context)

        // Apply proxy wrapping to app and springboard
        context.evaluateScript("app = _createProxy(app);")
        context.evaluateScript("springboard = _createProxy(springboard);")

        // Execute user code
        let result = context.evaluateScript(code)

        let resultStr = result?.toString() ?? "undefined"
        let jsErr = jsError

        // Break retain cycles: closures capture `context` which owns them.
        // Nil out all registered objects so JSContext and closures can deallocate.
        for key in ["console", "sleep", "device", "openApp", "app", "springboard", "_createProxy"] {
            context.setObject(nil, forKeyedSubscript: key as NSString)
        }
        context.exceptionHandler = nil

        if let err = jsErr {
            return JsResult(
                dict: ["result": err, "logs": logs],
                isError: true
            )
        }

        return JsResult(
            dict: ["result": resultStr, "logs": logs],
            isError: false
        )
    }

    // MARK: - Foreground App Resolution

    private static let foregroundLock = NSLock()
    private static var _lastForeground: AppHandle?
    private static var lastForeground: AppHandle? {
        get { foregroundLock.lock(); defer { foregroundLock.unlock() }; return _lastForeground }
        set { foregroundLock.lock(); _lastForeground = newValue; foregroundLock.unlock() }
    }

    /// Resolve foreground app with a 3s timeout. Falls back to last known app
    /// or springboard if resolution blocks (quiescence deadlock).
    private static func resolveForeground(extractor: UITreeExtractor) -> AppHandle {
        let sem = DispatchSemaphore(value: 0)
        var result: AppHandle?
        DispatchQueue.main.async {
            result = extractor.foregroundApp()
            sem.signal()
        }
        if sem.wait(timeout: .now() + 3) == .success, let handle = result {
            lastForeground = handle
            return handle
        }
        // Timed out — return last known foreground or springboard
        return lastForeground ?? AppHandle(
            app: XCUIApplication(bundleIdentifier: "com.apple.springboard"),
            bundleId: "com.apple.springboard"
        )
    }

    // MARK: - App Wrapping

    /// Wrap an XCUIApplication into a JSValue with all query collections and methods.
    private func wrapApp(
        _ app: XCUIApplication, bundleId: String, in context: JSContext
    ) -> JSValue {
        let obj = JSValue(newObjectIn: context)!

        obj.setObject(bundleId, forKeyedSubscript: "bundleID" as NSString)

        let stateFn: @convention(block) () -> UInt = { app.state.rawValue }
        obj.setObject(stateFn, forKeyedSubscript: "_getState" as NSString)

        // Element query collections
        let collections: [(String, XCUIElement.ElementType)] = [
            ("buttons", .button),
            ("textFields", .textField),
            ("secureTextFields", .secureTextField),
            ("staticTexts", .staticText),
            ("searchFields", .searchField),
            ("otherElements", .other),
            ("scrollViews", .scrollView),
            ("alerts", .alert),
            ("keyboards", .keyboard),
            ("windows", .window),
            ("images", .image),
            ("switches", .switch),
            ("cells", .cell),
            ("tables", .table),
            ("collectionViews", .collectionView),
            ("navigationBars", .navigationBar),
            ("tabBars", .tabBar),
            ("toolbars", .toolbar),
            ("pickers", .picker),
            ("textViews", .textView),
            ("links", .link),
            ("webViews", .webView),
            ("sliders", .slider),
            ("steppers", .stepper),
            ("segmentedControls", .segmentedControl),
        ]

        for (name, elementType) in collections {
            let query = app.descendants(matching: elementType)
            let wrappedQuery = wrapQuery(query, in: context)
            obj.setObject(wrappedQuery, forKeyedSubscript: name as NSString)
        }

        // Methods
        let launchFn: @convention(block) () -> Void = { DispatchQueue.main.sync { app.launch() } }
        let activateFn: @convention(block) () -> Void = { DispatchQueue.main.sync { app.activate() } }
        let terminateFn: @convention(block) () -> Void = { DispatchQueue.main.sync { app.terminate() } }
        let descendantsFn: @convention(block) (Int) -> JSValue = { [weak self] typeInt in
            guard let self = self else { return JSValue(undefinedIn: context) }
            let elemType = XCUIElement.ElementType(rawValue: UInt(typeInt)) ?? .any
            let query = app.descendants(matching: elemType)
            return self.wrapQuery(query, in: context)
        }

        obj.setObject(launchFn, forKeyedSubscript: "launch" as NSString)
        obj.setObject(activateFn, forKeyedSubscript: "activate" as NSString)
        obj.setObject(terminateFn, forKeyedSubscript: "terminate" as NSString)
        obj.setObject(descendantsFn, forKeyedSubscript: "descendants" as NSString)

        return obj
    }

    // MARK: - Query Wrapping

    /// Wrap an XCUIElementQuery into a JSValue with count, firstMatch, element(), etc.
    private func wrapQuery(_ query: XCUIElementQuery, in context: JSContext) -> JSValue {
        let obj = JSValue(newObjectIn: context)!

        obj.setObject(true, forKeyedSubscript: "_isQuery" as NSString)

        // count — dispatch to main where XCTContext exists
        let countFn: @convention(block) () -> Int = {
            do {
                var result = 0
                try ObjCExceptionCatcher.catchException {
                    result = DispatchQueue.main.sync { query.count }
                }
                return result
            } catch {
                context.exception = JSValue(
                    newErrorFromMessage: "count failed: \(error.localizedDescription)", in: context
                )
                return 0
            }
        }
        obj.setObject(countFn, forKeyedSubscript: "_getCount" as NSString)

        // firstMatch — dispatch to main where XCTContext exists
        let firstMatchFn: @convention(block) () -> JSValue = { [weak self] in
            guard let self = self else { return JSValue(undefinedIn: context) }
            do {
                var element: XCUIElement?
                try ObjCExceptionCatcher.catchException {
                    element = DispatchQueue.main.sync { query.firstMatch }
                }
                guard let el = element else {
                    context.exception = JSValue(newErrorFromMessage: "firstMatch returned nil", in: context)
                    return JSValue(undefinedIn: context)!
                }
                return self.wrapElement(el, in: context)
            } catch {
                context.exception = JSValue(
                    newErrorFromMessage: "firstMatch failed: \(error.localizedDescription)", in: context
                )
                return JSValue(undefinedIn: context)!
            }
        }
        obj.setObject(firstMatchFn, forKeyedSubscript: "_getFirstMatch" as NSString)

        // element(key) -- element by identifier (dispatch to main)
        let elementFn: @convention(block) (String) -> JSValue = { [weak self] key in
            guard let self = self else { return JSValue(undefinedIn: context) }
            do {
                var element: XCUIElement?
                try ObjCExceptionCatcher.catchException {
                    element = DispatchQueue.main.sync { query[key] }
                }
                guard let el = element else {
                    context.exception = JSValue(newErrorFromMessage: "element('\(key)') returned nil", in: context)
                    return JSValue(undefinedIn: context)!
                }
                return self.wrapElement(el, in: context)
            } catch {
                context.exception = JSValue(
                    newErrorFromMessage: "element lookup failed: \(error.localizedDescription)", in: context
                )
                return JSValue(undefinedIn: context)!
            }
        }
        obj.setObject(elementFn, forKeyedSubscript: "element" as NSString)

        // elementBoundBy(index) — dispatch to main
        let elementBoundByFn: @convention(block) (Int) -> JSValue = { [weak self] index in
            guard let self = self else { return JSValue(undefinedIn: context) }
            do {
                var element: XCUIElement?
                try ObjCExceptionCatcher.catchException {
                    element = DispatchQueue.main.sync { query.element(boundBy: index) }
                }
                guard let el = element else {
                    context.exception = JSValue(newErrorFromMessage: "elementBoundBy(\(index)) returned nil", in: context)
                    return JSValue(undefinedIn: context)!
                }
                return self.wrapElement(el, in: context)
            } catch {
                context.exception = JSValue(
                    newErrorFromMessage: "elementBoundBy failed: \(error.localizedDescription)", in: context
                )
                return JSValue(undefinedIn: context)!
            }
        }
        obj.setObject(elementBoundByFn, forKeyedSubscript: "elementBoundBy" as NSString)

        // matchingPredicate(format)
        let matchingPredFn: @convention(block) (String) -> JSValue = { [weak self] format in
            guard let self = self else { return JSValue(undefinedIn: context) }
            guard Self.isSafePredicateFormat(format) else {
                context.exception = JSValue(newErrorFromMessage: "Predicate format contains forbidden expression (FUNCTION/CAST/SUBQUERY)", in: context)
                return JSValue(undefinedIn: context)!
            }
            var predicate: NSPredicate?
            do {
                try ObjCExceptionCatcher.catchException {
                    predicate = NSPredicate(format: format)
                }
            } catch {
                context.exception = JSValue(newErrorFromMessage: "Invalid predicate format", in: context)
                return JSValue(undefinedIn: context)!
            }
            guard let pred = predicate else {
                context.exception = JSValue(newErrorFromMessage: "Invalid predicate format", in: context)
                return JSValue(undefinedIn: context)!
            }
            return self.wrapQuery(query.matching(pred), in: context)
        }
        obj.setObject(matchingPredFn, forKeyedSubscript: "matchingPredicate" as NSString)

        // containingPredicate(format)
        let containingPredFn: @convention(block) (String) -> JSValue = { [weak self] format in
            guard let self = self else { return JSValue(undefinedIn: context) }
            guard Self.isSafePredicateFormat(format) else {
                context.exception = JSValue(newErrorFromMessage: "Predicate format contains forbidden expression (FUNCTION/CAST/SUBQUERY)", in: context)
                return JSValue(undefinedIn: context)!
            }
            var predicate: NSPredicate?
            do {
                try ObjCExceptionCatcher.catchException {
                    predicate = NSPredicate(format: format)
                }
            } catch {
                context.exception = JSValue(newErrorFromMessage: "Invalid predicate format", in: context)
                return JSValue(undefinedIn: context)!
            }
            guard let pred = predicate else {
                context.exception = JSValue(newErrorFromMessage: "Invalid predicate format", in: context)
                return JSValue(undefinedIn: context)!
            }
            return self.wrapQuery(query.containing(pred), in: context)
        }
        obj.setObject(containingPredFn, forKeyedSubscript: "containingPredicate" as NSString)

        return obj
    }

    // MARK: - Predicate Safety

    /// Reject NSPredicate format strings that contain FUNCTION(), CAST(), or SUBQUERY()
    /// — these allow arbitrary Objective-C method invocation and are a sandbox escape.
    private static func isSafePredicateFormat(_ format: String) -> Bool {
        let upper = format.uppercased()
        let forbidden = ["FUNCTION", "CAST", "SUBQUERY"]
        for keyword in forbidden {
            if let range = upper.range(of: keyword) {
                // Check if followed by '(' (possibly with whitespace)
                let after = upper[range.upperBound...]
                let trimmed = after.drop(while: { $0 == " " || $0 == "\t" })
                if trimmed.hasPrefix("(") { return false }
            }
        }
        return true
    }

    // MARK: - Element Wrapping

    /// Wrap an XCUIElement into a JSValue with properties, sub-queries, and actions.
    private func wrapElement(_ element: XCUIElement, in context: JSContext) -> JSValue {
        let obj = JSValue(newObjectIn: context)!

        obj.setObject(true, forKeyedSubscript: "_isElement" as NSString)

        // Properties — dispatch to main thread where XCTContext exists
        // Query resolution (triggered by exists, label, etc.) requires XCTContext.
        let existsFn: @convention(block) () -> Bool = {
            DispatchQueue.main.sync { element.exists }
        }
        let isHittableFn: @convention(block) () -> Bool = {
            DispatchQueue.main.sync { guard element.exists else { return false }; return element.isHittable }
        }
        let isEnabledFn: @convention(block) () -> Bool = {
            DispatchQueue.main.sync { guard element.exists else { return false }; return element.isEnabled }
        }
        let isSelectedFn: @convention(block) () -> Bool = {
            DispatchQueue.main.sync { guard element.exists else { return false }; return element.isSelected }
        }
        let labelFn: @convention(block) () -> String = {
            DispatchQueue.main.sync { guard element.exists else { return "" }; return element.label }
        }
        let identifierFn: @convention(block) () -> String = {
            DispatchQueue.main.sync { element.identifier }
        }
        let titleFn: @convention(block) () -> String = {
            DispatchQueue.main.sync { guard element.exists else { return "" }; return element.title }
        }
        let valueFn: @convention(block) () -> JSValue = {
            DispatchQueue.main.sync {
                guard element.exists else { return JSValue(nullIn: context) }
                if let v = element.value {
                    // Coerce to safe types only — never bridge raw NSObjects into JSC
                    if let s = v as? String { return JSValue(object: s, in: context) }
                    if let n = v as? NSNumber { return JSValue(object: n, in: context) }
                    return JSValue(object: "\(v)", in: context)
                }
                return JSValue(nullIn: context)
            }
        }

        obj.setObject(existsFn, forKeyedSubscript: "_getExists" as NSString)
        obj.setObject(isHittableFn, forKeyedSubscript: "_getIsHittable" as NSString)
        obj.setObject(isEnabledFn, forKeyedSubscript: "_getIsEnabled" as NSString)
        obj.setObject(isSelectedFn, forKeyedSubscript: "_getIsSelected" as NSString)
        obj.setObject(labelFn, forKeyedSubscript: "_getLabel" as NSString)
        obj.setObject(identifierFn, forKeyedSubscript: "_getIdentifier" as NSString)
        obj.setObject(titleFn, forKeyedSubscript: "_getTitle" as NSString)
        obj.setObject(valueFn, forKeyedSubscript: "_getValue" as NSString)

        // Sub-queries (lazy)
        let subQueries: [(String, XCUIElement.ElementType)] = [
            ("buttons", .button),
            ("textFields", .textField),
            ("secureTextFields", .secureTextField),
            ("staticTexts", .staticText),
            ("searchFields", .searchField),
            ("otherElements", .other),
            ("scrollViews", .scrollView),
            ("images", .image),
            ("switches", .switch),
            ("cells", .cell),
            ("links", .link),
        ]

        for (name, elementType) in subQueries {
            let subQueryFn: @convention(block) () -> JSValue = { [weak self] in
                guard let self = self else { return JSValue(undefinedIn: context) }
                let q = element.descendants(matching: elementType)
                return self.wrapQuery(q, in: context)
            }
            obj.setObject(subQueryFn, forKeyedSubscript: "_getSubQuery_\(name)" as NSString)
        }

        // Actions (guarded -- dispatch to main, catch ObjC exceptions, set JS error on failure)
        func guardedAction(_ action: @escaping () -> Void) -> @convention(block) () -> Void {
            return {
                DispatchQueue.main.sync {
                    do {
                        try ObjCExceptionCatcher.catchException {
                            guard element.exists else {
                                context.exception = JSValue(
                                    newErrorFromMessage: "Element does not exist", in: context
                                )
                                return
                            }
                            action()
                        }
                    } catch {
                        context.exception = JSValue(
                            newErrorFromMessage: error.localizedDescription, in: context
                        )
                    }
                }
            }
        }

        obj.setObject(guardedAction { element.tap() }, forKeyedSubscript: "tap" as NSString)
        obj.setObject(guardedAction { element.doubleTap() }, forKeyedSubscript: "doubleTap" as NSString)
        obj.setObject(guardedAction { element.swipeUp() }, forKeyedSubscript: "swipeUp" as NSString)
        obj.setObject(guardedAction { element.swipeDown() }, forKeyedSubscript: "swipeDown" as NSString)
        obj.setObject(guardedAction { element.swipeLeft() }, forKeyedSubscript: "swipeLeft" as NSString)
        obj.setObject(guardedAction { element.swipeRight() }, forKeyedSubscript: "swipeRight" as NSString)

        let typeTextFn: @convention(block) (String) -> Void = { text in
            DispatchQueue.main.sync {
                do {
                    try ObjCExceptionCatcher.catchException {
                        guard element.exists else {
                            context.exception = JSValue(
                                newErrorFromMessage: "Element does not exist", in: context
                            )
                            return
                        }
                        element.typeText(text)
                    }
                } catch {
                    context.exception = JSValue(
                        newErrorFromMessage: error.localizedDescription, in: context
                    )
                }
            }
        }
        let pressForDurationFn: @convention(block) (Double) -> Void = { seconds in
            DispatchQueue.main.sync {
                do {
                    try ObjCExceptionCatcher.catchException {
                        guard element.exists else {
                            context.exception = JSValue(
                                newErrorFromMessage: "Element does not exist", in: context
                            )
                            return
                        }
                        element.press(forDuration: seconds)
                    }
                } catch {
                    context.exception = JSValue(
                        newErrorFromMessage: error.localizedDescription, in: context
                    )
                }
            }
        }
        let waitForExistenceFn: @convention(block) (Double) -> Bool = { timeout in
            DispatchQueue.main.sync { element.waitForExistence(timeout: timeout) }
        }
        let descendantsFn: @convention(block) (Int) -> JSValue = { [weak self] typeInt in
            guard let self = self else { return JSValue(undefinedIn: context) }
            let elemType = XCUIElement.ElementType(rawValue: UInt(typeInt)) ?? .any
            return self.wrapQuery(element.descendants(matching: elemType), in: context)
        }

        obj.setObject(typeTextFn, forKeyedSubscript: "typeText" as NSString)
        obj.setObject(pressForDurationFn, forKeyedSubscript: "pressForDuration" as NSString)
        obj.setObject(waitForExistenceFn, forKeyedSubscript: "waitForExistence" as NSString)
        obj.setObject(descendantsFn, forKeyedSubscript: "descendants" as NSString)

        return obj
    }

    // MARK: - Proxy Shim

    /// Install the Proxy shim in the JSContext so that bracket notation
    /// on queries calls element() internally. Return values are recursively
    /// wrapped to maintain the proxy chain.
    private func installProxyShim(in context: JSContext) {
        context.evaluateScript("""
        function _createProxy(target) {
            if (target === null || target === undefined) return target;
            if (typeof target !== 'object' && typeof target !== 'function') return target;

            return new Proxy(target, {
                get: function(obj, prop) {
                    // Handle property getters for queries
                    if (prop === 'count' && obj._isQuery) {
                        return obj._getCount();
                    }
                    if (prop === 'firstMatch' && obj._isQuery) {
                        return _createProxy(obj._getFirstMatch());
                    }

                    // Handle property getters for elements
                    if (obj._isElement) {
                        if (prop === 'exists') return obj._getExists();
                        if (prop === 'isHittable') return obj._getIsHittable();
                        if (prop === 'isEnabled') return obj._getIsEnabled();
                        if (prop === 'isSelected') return obj._getIsSelected();
                        if (prop === 'label') return obj._getLabel();
                        if (prop === 'identifier') return obj._getIdentifier();
                        if (prop === 'title') return obj._getTitle();
                        if (prop === 'value') return obj._getValue();
                    }

                    // Handle sub-query getters for elements
                    var subQueryProps = [
                        'buttons', 'textFields', 'secureTextFields', 'staticTexts',
                        'searchFields', 'otherElements', 'scrollViews', 'images',
                        'switches', 'cells', 'links'
                    ];
                    if (obj._isElement && subQueryProps.indexOf(prop) !== -1) {
                        var getter = obj['_getSubQuery_' + prop];
                        if (getter) return _createProxy(getter());
                    }

                    // Handle app property getters
                    if (!obj._isElement && !obj._isQuery && prop === 'state' && obj._getState) {
                        return obj._getState();
                    }

                    // Handle query collection getters for apps
                    var queryCollections = [
                        'buttons', 'textFields', 'secureTextFields', 'staticTexts',
                        'searchFields', 'otherElements', 'scrollViews', 'alerts',
                        'keyboards', 'windows', 'images', 'switches', 'cells',
                        'tables', 'collectionViews', 'navigationBars', 'tabBars',
                        'toolbars', 'pickers', 'textViews', 'links', 'webViews',
                        'sliders', 'steppers', 'segmentedControls'
                    ];
                    if (!obj._isElement && !obj._isQuery && queryCollections.indexOf(prop) !== -1) {
                        var val = obj[prop];
                        if (val) return _createProxy(val);
                    }

                    // Direct property access
                    var value = obj[prop];
                    if (typeof value === 'function') {
                        return function() {
                            var result = value.apply(obj, arguments);
                            return _createProxy(result);
                        };
                    }
                    if (typeof value === 'object' && value !== null) {
                        return _createProxy(value);
                    }
                    if (value !== undefined) {
                        return value;
                    }

                    // Bracket notation on queries: app.buttons["Login"] -> element("Login")
                    if (obj._isQuery && typeof prop === 'string') {
                        var elemFn = obj.element;
                        if (elemFn) {
                            return _createProxy(elemFn.call(obj, prop));
                        }
                    }

                    return undefined;
                }
            });
        }
        """)
    }
}
