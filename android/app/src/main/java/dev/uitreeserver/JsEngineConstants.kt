package dev.uitreeserver

object JsEngineConstants {

    const val MAX_INSTRUCTIONS = 10_000_000

    val BLOCKED_METHODS = setOf(
        "getClass", "class", "forName",
        "notify", "notifyAll",
        "classLoader", "getClassLoader"
    )

    val BLOCKED_PREFIXES = listOf(
        "java.lang.reflect",
        "java.lang.invoke",
        "java.lang.Runtime",
        "java.lang.Process",
        "java.lang.ProcessBuilder",
        "java.lang.System",
        "java.lang.Thread",
        "java.lang.Class",
        "java.lang.ClassLoader",
        "java.lang.SecurityManager",
        "java.lang.ThreadGroup",
        "java.io",
        "java.nio",
        "java.net",
        "javax.net",
        "okhttp",
        "org.apache.http"
    )

    val ALLOWED_CLASSES = setOf(
        "java.lang.String",
        "java.lang.Integer",
        "java.lang.Long",
        "java.lang.Double",
        "java.lang.Float",
        "java.lang.Boolean",
        "java.lang.Byte",
        "java.lang.Short",
        "java.lang.Character",
        "java.lang.Math",
        "java.lang.Number",
        "java.lang.Object",
        "java.lang.Comparable",
        "java.lang.Iterable",
        "java.util.ArrayList",
        "java.util.HashMap",
        "java.util.LinkedHashMap",
        "java.util.Arrays",
        "java.util.Collections",
        "java.util.List",
        "java.util.Map",
        "java.util.Iterator",
        "java.util.regex.Pattern",
        "java.util.regex.Matcher",
        "android.graphics.Point",
        "android.graphics.Rect",
        "android.view.KeyEvent",
    )

    fun isClassAllowed(className: String): Boolean {
        for (prefix in BLOCKED_PREFIXES) {
            if (className.startsWith(prefix)) return false
        }
        if (className.startsWith("androidx.test.uiautomator")) return true
        if (className in ALLOWED_CLASSES) return true
        return false
    }
}
