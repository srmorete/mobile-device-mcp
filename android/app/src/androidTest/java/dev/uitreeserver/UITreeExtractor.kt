package dev.uitreeserver

import android.app.UiAutomation
import android.graphics.Rect
import android.os.Build
import android.view.Surface
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice

/**
 * Extracts the accessibility tree from the device screen.
 * Handles multi-window capture, bounds clipping, text sanitization, and hint text.
 */
class UITreeExtractor(private val device: UiDevice) {

    fun extract(): UITreeResponse {
        val screenWidth = device.displayWidth
        val screenHeight = device.displayHeight
        val rotation = when (device.displayRotation) {
            Surface.ROTATION_0 -> 0
            Surface.ROTATION_90 -> 90
            Surface.ROTATION_180 -> 180
            Surface.ROTATION_270 -> 270
            else -> 0
        }

        val nodes = extractMultiWindow(screenWidth, screenHeight)
        return UITreeResponse(rotation, screenWidth, screenHeight, nodes)
    }

    private fun getUiAutomation(): UiAutomation {
        return InstrumentationRegistry.getInstrumentation().uiAutomation
    }

    private fun extractMultiWindow(screenWidth: Int, screenHeight: Int): List<UITreeNode> {
        return try {
            val uiAutomation = getUiAutomation()
            val windows = uiAutomation.windows
            if (windows.isNullOrEmpty()) {
                extractActiveWindow(screenWidth, screenHeight)
            } else {
                val nodes = mutableListOf<UITreeNode>()
                for (window in windows) {
                    try {
                        val root = window.root ?: continue
                        try {
                            nodes.add(convertNode(root, screenWidth, screenHeight))
                        } finally {
                            root.recycle()
                        }
                    } finally {
                        window.recycle()
                    }
                }
                if (nodes.isEmpty()) extractActiveWindow(screenWidth, screenHeight) else nodes
            }
        } catch (_: Exception) {
            extractActiveWindow(screenWidth, screenHeight)
        }
    }

    private fun extractActiveWindow(screenWidth: Int, screenHeight: Int): List<UITreeNode> {
        val root = try {
            getUiAutomation().rootInActiveWindow
        } catch (_: Exception) {
            null
        } ?: return emptyList()

        return try {
            listOf(convertNode(root, screenWidth, screenHeight))
        } finally {
            root.recycle()
        }
    }

    private fun convertNode(node: AccessibilityNodeInfo, screenWidth: Int, screenHeight: Int): UITreeNode {
        val rect = Rect()
        node.getBoundsInScreen(rect)
        val clipped = UITreeUtils.clipBounds(rect.left, rect.top, rect.right, rect.bottom, screenWidth, screenHeight)

        val children = mutableListOf<UITreeNode>()
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            try {
                children.add(convertNode(child, screenWidth, screenHeight))
            } finally {
                child.recycle()
            }
        }

        val hintText: String? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            TextSanitizer.sanitize(node.hintText?.toString())
        } else {
            null
        }

        return UITreeNode(
            className = node.className?.toString(),
            text = TextSanitizer.sanitize(node.text?.toString()),
            hintText = hintText,
            contentDesc = TextSanitizer.sanitize(node.contentDescription?.toString()),
            resourceId = node.viewIdResourceName,
            packageName = node.packageName?.toString(),
            bounds = clipped,
            checkable = node.isCheckable,
            checked = node.isChecked,
            clickable = node.isClickable,
            enabled = node.isEnabled,
            focusable = node.isFocusable,
            focused = node.isFocused,
            scrollable = node.isScrollable,
            longClickable = node.isLongClickable,
            password = node.isPassword,
            selected = node.isSelected,
            visibleToUser = node.isVisibleToUser,
            children = children
        )
    }
}
