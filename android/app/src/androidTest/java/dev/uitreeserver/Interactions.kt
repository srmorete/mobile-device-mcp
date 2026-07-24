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

    fun type(text: String): Pair<Boolean, String?> {
        var focused = findFocusedEditableNode()
            ?: return Pair(false, "No focused element found")

        // Web inputs (Chrome/WebView) silently drop ACTION_SET_TEXT when the field only has
        // visual focus from an injected touch — the renderer never got real editable focus
        // (symptom: soft keyboard doesn't open). ACTION_CLICK on the node activates it
        // through the accessibility pathway, which grants renderer focus.
        // On native fields this click is harmless (cursor reposition).
        // Never click non-editable nodes: that could activate buttons/links.
        if (focused.isEditable) {
            val clicked = focused.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            val className = focused.className
            focused.recycle()
            if (!clicked) {
                android.util.Log.i("Interactions", "type: ACTION_CLICK returned false on $className")
            }
            // The node may be stale after the click; re-fetch before SET_TEXT.
            focused = findFocusedEditableNode()
                ?: return Pair(false, "Focused element lost after focus click")
        }

        val args = android.os.Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        val className = focused.className
        val applied = focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        android.util.Log.i("Interactions", "type: target=$className editable=${focused.isEditable} setText=$applied")
        focused.recycle()
        if (!applied) {
            android.util.Log.w("Interactions", "type: ACTION_SET_TEXT rejected by $className")
            return Pair(false, "Focused element ($className) rejected text input")
        }
        return Pair(true, null)
    }

    private fun findFocusedEditableNode(): AccessibilityNodeInfo? {
        val root = try {
            instrumentation.uiAutomation.rootInActiveWindow
        } catch (_: Exception) {
            null
        } ?: return null
        val focused = findFocusedNode(root)
        root.recycle()
        return focused
    }

    private fun findFocusedNode(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        // Prefer a node that is both focused and editable (matches By.focused(true)
        // semantics used elsewhere). findFocus(FOCUS_INPUT) can return a non-editable
        // container in Chrome/WebViews after a11y actions, and SET_TEXT on it is
        // silently dropped while still returning true.
        findEditableFocused(root)?.let { return it }
        // Fallback: input focus reported by the view system
        return root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
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
