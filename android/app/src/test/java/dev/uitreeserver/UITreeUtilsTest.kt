package dev.uitreeserver

import org.junit.Assert.*
import org.junit.Test

class UITreeUtilsTest {

    private fun node(
        className: String? = "android.widget.View",
        resourceId: String? = null,
        bounds: Bounds? = Bounds(0, 0, 100, 50),
        children: List<UITreeNode> = emptyList()
    ) = UITreeNode(
        className = className, text = null, hintText = null, contentDesc = null,
        resourceId = resourceId, packageName = null, bounds = bounds,
        checkable = false, checked = false, clickable = false, enabled = true,
        focusable = false, focused = false, scrollable = false, longClickable = false,
        password = false, selected = false, visibleToUser = true, children = children
    )

    // --- clipBounds ---

    @Test
    fun `clipBounds within screen unchanged`() {
        val b = UITreeUtils.clipBounds(10, 20, 90, 80, 100, 100)
        assertEquals(Bounds(10, 20, 90, 80), b)
    }

    @Test
    fun `clipBounds clamps negative to zero`() {
        val b = UITreeUtils.clipBounds(-10, -5, 50, 50, 100, 100)
        assertEquals(0, b.left)
        assertEquals(0, b.top)
    }

    @Test
    fun `clipBounds clamps beyond screen to max`() {
        val b = UITreeUtils.clipBounds(0, 0, 200, 300, 100, 100)
        assertEquals(100, b.right)
        assertEquals(100, b.bottom)
    }

    // --- findWebViewContainers ---

    @Test
    fun `findWebViewContainers empty tree`() {
        assertTrue(UITreeUtils.findWebViewContainers(emptyList()).isEmpty())
    }

    @Test
    fun `findWebViewContainers finds webview`() {
        val webview = node(className = "android.webkit.WebView")
        val containers = UITreeUtils.findWebViewContainers(listOf(webview))
        assertEquals(1, containers.size)
        assertFalse(containers[0].isChromeCCT)
    }

    @Test
    fun `findWebViewContainers finds chrome CCT`() {
        val cct = node(resourceId = "com.android.chrome:id/compositor_view_holder")
        val containers = UITreeUtils.findWebViewContainers(listOf(cct))
        assertEquals(1, containers.size)
        assertTrue(containers[0].isChromeCCT)
    }

    @Test
    fun `findWebViewContainers finds nested`() {
        val webview = node(className = "android.webkit.WebView")
        val parent = node(children = listOf(webview))
        val containers = UITreeUtils.findWebViewContainers(listOf(parent))
        assertEquals(1, containers.size)
    }

    @Test
    fun `findWebViewContainers ignores non-webview`() {
        val button = node(className = "android.widget.Button")
        assertTrue(UITreeUtils.findWebViewContainers(listOf(button)).isEmpty())
    }

    // --- augmentTreeWithWebViewNodes ---

    @Test
    fun `augmentTree adds children to matching node`() {
        val webview = node(className = "android.webkit.WebView")
        val extra = node(className = "webview.Button")
        val augmented = UITreeUtils.augmentTreeWithWebViewNodes(
            listOf(webview), mapOf(webview to listOf(extra))
        )
        assertEquals(1, augmented[0].children.size)
        assertEquals("webview.Button", augmented[0].children[0].className)
    }

    @Test
    fun `augmentTree no match returns unchanged`() {
        val n = node()
        val augmented = UITreeUtils.augmentTreeWithWebViewNodes(listOf(n), emptyMap())
        assertEquals(0, augmented[0].children.size)
    }

    @Test
    fun `augmentTree works on deep nesting`() {
        val webview = node(className = "android.webkit.WebView")
        val parent = node(children = listOf(webview))
        val extra = node(className = "webview.Link")
        val augmented = UITreeUtils.augmentTreeWithWebViewNodes(
            listOf(parent), mapOf(webview to listOf(extra))
        )
        assertEquals(1, augmented[0].children[0].children.size)
    }

    // --- findNodeByResourceId ---

    @Test
    fun `findNodeByResourceId found at root`() {
        val n = node(resourceId = "com.app:id/button")
        val found = UITreeUtils.findNodeByResourceId(listOf(n), "com.app:id/button")
        assertNotNull(found)
    }

    @Test
    fun `findNodeByResourceId found nested`() {
        val target = node(resourceId = "com.app:id/target")
        val parent = node(children = listOf(target))
        val found = UITreeUtils.findNodeByResourceId(listOf(parent), "com.app:id/target")
        assertNotNull(found)
        assertEquals("com.app:id/target", found?.resourceId)
    }

    @Test
    fun `findNodeByResourceId not found`() {
        val n = node(resourceId = "com.app:id/other")
        assertNull(UITreeUtils.findNodeByResourceId(listOf(n), "com.app:id/missing"))
    }
}
