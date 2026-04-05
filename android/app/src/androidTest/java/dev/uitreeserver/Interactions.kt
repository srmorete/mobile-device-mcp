package dev.uitreeserver

import android.app.Instrumentation
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.uiautomator.UiDevice

/**
 * Device interaction commands: tap, scroll, type, press, launch, terminate, list apps.
 */
class Interactions(private val device: UiDevice, private val instrumentation: Instrumentation) {

    fun tap(x: Int, y: Int): Boolean {
        return device.click(x, y)
    }

    fun doubleTap(x: Int, y: Int) {
        device.click(x, y)
        Thread.sleep(50)
        device.click(x, y)
    }

    fun longPress(x: Int, y: Int, duration: Int = 500) {
        val clampedDuration = duration.coerceIn(1, 10000)
        val steps = maxOf(clampedDuration / 5, 1)
        device.swipe(x, y, x, y, steps)
    }

    fun scroll(startX: Int, startY: Int, endX: Int, endY: Int) {
        device.swipe(startX, startY, endX, endY, 10)
    }

    fun type(text: String): Boolean {
        val root = try {
            val uiAutomation = instrumentation.uiAutomation
            uiAutomation.rootInActiveWindow
        } catch (_: Exception) {
            null
        } ?: return false

        val focused = findFocusedNode(root)
        if (focused == null) {
            root.recycle()
            return false
        }

        try {
            val args = android.os.Bundle()
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
            focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        } finally {
            focused.recycle()
            root.recycle()
        }
        return true
    }

    private fun findFocusedNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        // Prefer input focus (the editable field) over accessibility focus (the container)
        val inputFocused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
        if (inputFocused != null) return inputFocused
        // Fallback: walk tree for any focused + editable node
        return findEditableFocused(root)
    }

    private fun findEditableFocused(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (node.isFocused && node.isEditable) return AccessibilityNodeInfo.obtain(node)
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val result = findEditableFocused(child)
            child.recycle()
            if (result != null) return result
        }
        return null
    }

    fun press(button: String): Pair<Boolean, String?> {
        val (keyCode, error) = InteractionUtils.resolveButton(button)
        if (keyCode == null) {
            return Pair(false, error)
        }
        return Pair(device.pressKeyCode(keyCode), null)
    }

    fun launchApp(packageName: String): Pair<Boolean, String?> {
        if (!InteractionUtils.isValidPackageName(packageName)) {
            return Pair(false, "Invalid package name '$packageName'. Must match [a-zA-Z0-9._]+")
        }
        val activity = resolveLauncherActivity(packageName, 0)
        if (activity != null) {
            executeShellCommand("am start --user 0 -n $activity")
            return Pair(true, null)
        }

        val users = getWorkProfileUsers()
        for (userId in users) {
            val workActivity = resolveLauncherActivity(packageName, userId)
            if (workActivity != null) {
                executeShellCommand("am start --user $userId -n $workActivity")
                return Pair(true, null)
            }
        }

        return Pair(false, "No launcher activity found for package '$packageName'")
    }

    private fun resolveLauncherActivity(packageName: String, userId: Int): String? {
        val output = executeShellCommand(
            "cmd package resolve-activity --user $userId -c android.intent.category.LAUNCHER $packageName"
        )
        for (line in output.lines()) {
            val trimmed = line.trim()
            if (trimmed.startsWith("name=")) {
                val activityName = trimmed.removePrefix("name=")
                if (activityName.isNotBlank()) {
                    return "$packageName/$activityName"
                }
            }
        }
        return null
    }

    private fun getWorkProfileUsers(): List<Int> {
        val output = executeShellCommand("pm list users")
        val users = mutableListOf<Int>()
        val regex = Regex("""UserInfo\{(\d+):""")
        for (line in output.lines()) {
            val match = regex.find(line) ?: continue
            val userId = match.groupValues[1].toIntOrNull() ?: continue
            if (userId != 0) {
                users.add(userId)
            }
        }
        return users
    }

    fun terminateApp(packageName: String): Pair<Boolean, String?> {
        if (!InteractionUtils.isValidPackageName(packageName)) {
            return Pair(false, "Invalid package name '$packageName'. Must match [a-zA-Z0-9._]+")
        }
        executeShellCommand("am force-stop $packageName")
        return Pair(true, null)
    }

    fun listApps(): List<String> {
        val output = executeShellCommand("pm list packages")
        return output.lines()
            .filter { it.startsWith("package:") }
            .map { it.removePrefix("package:").trim() }
            .filter { it.isNotEmpty() }
            .sorted()
    }

    private fun executeShellCommand(command: String): String {
        return device.executeShellCommand(command) ?: ""
    }
}
