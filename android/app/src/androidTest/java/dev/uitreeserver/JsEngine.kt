package dev.uitreeserver

import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.mozilla.javascript.ClassShutter
import org.mozilla.javascript.Context
import org.mozilla.javascript.ContextFactory
import org.mozilla.javascript.NativeJavaClass
import org.mozilla.javascript.NativeJavaObject
import org.mozilla.javascript.Scriptable
import org.mozilla.javascript.ScriptableObject
import org.mozilla.javascript.WrapFactory

/**
 * Sandboxed JavaScript engine using Mozilla Rhino with UIAutomator bindings.
 *
 * Available bindings:
 * - uiDevice: Device automation (sandboxed subset of methods)
 * - By: Selector builder
 * - Until: Condition builder
 * - console.log(): Output captured in response logs array
 */
class JsEngine(private val device: UiDevice, private val coord: Coord) {

    companion object {
        // ContextFactory that enforces instruction-count timeout
        private val sandboxFactory = object : ContextFactory() {
            override fun observeInstructionCount(cx: Context, instructionCount: Int) {
                if (instructionCount > JsEngineConstants.MAX_INSTRUCTIONS) {
                    throw Error("Script execution exceeded ${JsEngineConstants.MAX_INSTRUCTIONS} instruction limit")
                }
            }
        }
    }

    fun execute(code: String): ExecResult {
        val logs = mutableListOf<String>()
        val context = sandboxFactory.enterContext()
        try {
            context.optimizationLevel = -1 // Interpreted mode for Android
            context.languageVersion = Context.VERSION_1_8
            context.instructionObserverThreshold = 100_000

            // WrapFactory that blocks getClass() and other dangerous Object methods
            // on all Java objects bridged into JS (prevents sandbox escape via reflection)
            context.wrapFactory = object : WrapFactory() {
                override fun wrapAsJavaObject(
                    cx: Context, scope: Scriptable, javaObject: Any, staticType: Class<*>?
                ): Scriptable {
                    return object : NativeJavaObject(scope, javaObject, staticType) {
                        override fun get(name: String, start: Scriptable): Any {
                            if (name in JsEngineConstants.BLOCKED_METHODS) return Scriptable.NOT_FOUND
                            return super.get(name, start)
                        }
                    }
                }
            }

            // Strict class shutter: blocklist + whitelist (uiautomator broadly allowed)
            context.setClassShutter(ClassShutter { className ->
                JsEngineConstants.isClassAllowed(className)
            })

            val scope = context.initStandardObjects()

            // Build console object with captured log
            val consoleObj = context.newObject(scope)
            val logFn = object : org.mozilla.javascript.BaseFunction() {
                override fun call(
                    cx: Context, scope: Scriptable,
                    thisObj: Scriptable, args: Array<out Any?>
                ): Any? {
                    val message = args.joinToString(" ") { arg ->
                        stringify(arg)
                    }
                    logs.add(message)
                    return Context.getUndefinedValue()
                }
            }
            ScriptableObject.putProperty(consoleObj as ScriptableObject, "log", logFn)
            ScriptableObject.putProperty(scope, "console", consoleObj)

            // Add uiDevice binding (safe wrapper — never expose raw UiDevice or executeShellCommand)
            val uiDeviceWrapper = context.newObject(scope)
            val wrapperScope = uiDeviceWrapper as ScriptableObject

            // Screen info — reported in render space to match HTTP handlers.
            val getWidthFn = simpleFunc { coord.toRenderInt(device.displayWidth) }
            val getHeightFn = simpleFunc { coord.toRenderInt(device.displayHeight) }
            val getRotationFn = simpleFunc { device.displayRotation }
            ScriptableObject.putProperty(wrapperScope, "displayWidth", getWidthFn)
            ScriptableObject.putProperty(wrapperScope, "displayHeight", getHeightFn)
            ScriptableObject.putProperty(wrapperScope, "displayRotation", getRotationFn)

            // Interactions — inputs in render space (Float to preserve sub-pixel precision
            // from JS numbers), converted to native before dispatch.
            val clickFn = coordFn2 { x, y ->
                device.click(coord.toNativeInt(x), coord.toNativeInt(y))
            }
            val swipeFn = coordFn4WithSteps { sx, sy, ex, ey, steps ->
                device.swipe(
                    coord.toNativeInt(sx), coord.toNativeInt(sy),
                    coord.toNativeInt(ex), coord.toNativeInt(ey),
                    steps
                )
            }
            val pressKeyCodeFn = simpleFunc1Int { keyCode -> device.pressKeyCode(keyCode) }
            val pressBackFn = simpleFunc { device.pressBack() }
            val pressHomeFn = simpleFunc { device.pressHome() }
            val pressRecentAppsFn = simpleFunc { device.pressRecentApps() }
            ScriptableObject.putProperty(wrapperScope, "click", clickFn)
            ScriptableObject.putProperty(wrapperScope, "swipe", swipeFn)
            ScriptableObject.putProperty(wrapperScope, "pressKeyCode", pressKeyCodeFn)
            ScriptableObject.putProperty(wrapperScope, "pressBack", pressBackFn)
            ScriptableObject.putProperty(wrapperScope, "pressHome", pressHomeFn)
            ScriptableObject.putProperty(wrapperScope, "pressRecentApps", pressRecentAppsFn)

            // Waits
            val waitForIdleFn = simpleFunc { device.waitForIdle() }
            val waitForIdleTimeoutFn = simpleFunc1Long { ms -> device.waitForIdle(ms) }
            ScriptableObject.putProperty(wrapperScope, "waitForIdle", waitForIdleFn)
            ScriptableObject.putProperty(wrapperScope, "waitForIdleTimeout", waitForIdleTimeoutFn)

            // Finders
            val findObjectFn = object : org.mozilla.javascript.BaseFunction() {
                override fun call(
                    cx: Context, scope: Scriptable,
                    thisObj: Scriptable, args: Array<out Any?>
                ): Any? {
                    val selector = args.getOrNull(0) ?: return Context.getUndefinedValue()
                    val unwrapped = if (selector is NativeJavaObject) selector.unwrap() else selector
                    if (unwrapped is androidx.test.uiautomator.BySelector) {
                        val obj = device.findObject(unwrapped)
                        return Context.javaToJS(obj, scope)
                    }
                    return Context.getUndefinedValue()
                }
            }
            val hasObjectFn = object : org.mozilla.javascript.BaseFunction() {
                override fun call(
                    cx: Context, scope: Scriptable,
                    thisObj: Scriptable, args: Array<out Any?>
                ): Any? {
                    val selector = args.getOrNull(0) ?: return false
                    val unwrapped = if (selector is NativeJavaObject) selector.unwrap() else selector
                    if (unwrapped is androidx.test.uiautomator.BySelector) {
                        return device.hasObject(unwrapped)
                    }
                    return false
                }
            }
            val waitFn = object : org.mozilla.javascript.BaseFunction() {
                override fun call(
                    cx: Context, scope: Scriptable,
                    thisObj: Scriptable, args: Array<out Any?>
                ): Any? {
                    val condition = args.getOrNull(0) ?: return Context.getUndefinedValue()
                    val timeout = (args.getOrNull(1) as? Number)?.toLong() ?: 5000L
                    val unwrapped = if (condition is NativeJavaObject) condition.unwrap() else condition
                    @Suppress("UNCHECKED_CAST")
                    val result = device.wait(unwrapped as androidx.test.uiautomator.SearchCondition<Any>, timeout)
                    return Context.javaToJS(result, scope)
                }
            }
            ScriptableObject.putProperty(wrapperScope, "findObject", findObjectFn)
            ScriptableObject.putProperty(wrapperScope, "hasObject", hasObjectFn)
            ScriptableObject.putProperty(wrapperScope, "wait", waitFn)

            ScriptableObject.putProperty(scope, "uiDevice", uiDeviceWrapper)

            // Add By and Until as NativeJavaClass so static methods are callable directly
            ScriptableObject.putProperty(scope, "By", NativeJavaClass(scope, By::class.java))
            ScriptableObject.putProperty(scope, "Until", NativeJavaClass(scope, Until::class.java))

            val result = context.evaluateString(scope, code, "<exec>", 1, null)

            val resultStr = stringify(result)
            return ExecResult(resultStr, logs)
        } finally {
            Context.exit()
        }
    }

    // Helper factories for safe Rhino functions

    private fun simpleFunc(block: () -> Any?): org.mozilla.javascript.BaseFunction {
        return object : org.mozilla.javascript.BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any? {
                return Context.javaToJS(block(), scope)
            }
        }
    }

    private fun simpleFunc1Int(block: (Int) -> Any?): org.mozilla.javascript.BaseFunction {
        return object : org.mozilla.javascript.BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any? {
                val a = (args.getOrNull(0) as? Number)?.toInt() ?: return Context.getUndefinedValue()
                return Context.javaToJS(block(a), scope)
            }
        }
    }

    private fun simpleFunc1Long(block: (Long) -> Any?): org.mozilla.javascript.BaseFunction {
        return object : org.mozilla.javascript.BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any? {
                val a = (args.getOrNull(0) as? Number)?.toLong() ?: return Context.getUndefinedValue()
                return Context.javaToJS(block(a), scope)
            }
        }
    }

    /** Two render-space coordinate args as Float (preserves sub-pixel precision). */
    private fun coordFn2(block: (Float, Float) -> Any?): org.mozilla.javascript.BaseFunction {
        return object : org.mozilla.javascript.BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any? {
                val a = (args.getOrNull(0) as? Number)?.toFloat() ?: return Context.getUndefinedValue()
                val b = (args.getOrNull(1) as? Number)?.toFloat() ?: return Context.getUndefinedValue()
                return Context.javaToJS(block(a, b), scope)
            }
        }
    }

    /** Four render-space coordinates (Float) plus an Int step count. */
    private fun coordFn4WithSteps(block: (Float, Float, Float, Float, Int) -> Any?): org.mozilla.javascript.BaseFunction {
        return object : org.mozilla.javascript.BaseFunction() {
            override fun call(cx: Context, scope: Scriptable, thisObj: Scriptable, args: Array<out Any?>): Any? {
                val a = (args.getOrNull(0) as? Number)?.toFloat() ?: return Context.getUndefinedValue()
                val b = (args.getOrNull(1) as? Number)?.toFloat() ?: return Context.getUndefinedValue()
                val c = (args.getOrNull(2) as? Number)?.toFloat() ?: return Context.getUndefinedValue()
                val d = (args.getOrNull(3) as? Number)?.toFloat() ?: return Context.getUndefinedValue()
                val e = (args.getOrNull(4) as? Number)?.toInt() ?: return Context.getUndefinedValue()
                return Context.javaToJS(block(a, b, c, d, e), scope)
            }
        }
    }

    private fun stringify(value: Any?): String {
        return when (value) {
            null -> "null"
            Context.getUndefinedValue() -> "undefined"
            is NativeJavaObject -> value.unwrap()?.toString() ?: "null"
            is Scriptable -> {
                try {
                    Context.toString(value)
                } catch (_: Exception) {
                    value.toString()
                }
            }
            else -> Context.toString(value)
        }
    }
}
