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

    // --- scaleBounds / scaleNodes ---

    @Test
    fun `scaleBounds identity scale unchanged`() {
        val b = Bounds(10, 20, 90, 80)
        assertEquals(b, UITreeUtils.scaleBounds(b, 1.0f))
    }

    @Test
    fun `scaleBounds scales down`() {
        val b = Bounds(100, 200, 300, 400)
        val scaled = UITreeUtils.scaleBounds(b, 0.5f)
        assertEquals(Bounds(50, 100, 150, 200), scaled)
    }

    @Test
    fun `scaleBounds rounds correctly`() {
        val b = Bounds(10, 10, 11, 11)
        val scaled = UITreeUtils.scaleBounds(b, 0.667f)
        assertEquals(Bounds(7, 7, 7, 7), scaled)
    }

    @Test
    fun `scaleNodes scales bounds and recurses`() {
        val child = node(bounds = Bounds(50, 50, 100, 100))
        val parent = node(bounds = Bounds(0, 0, 200, 200), children = listOf(child))
        val scaled = UITreeUtils.scaleNodes(listOf(parent), 0.5f)
        assertEquals(Bounds(0, 0, 100, 100), scaled[0].bounds)
        assertEquals(Bounds(25, 25, 50, 50), scaled[0].children[0].bounds)
    }

    @Test
    fun `scaleNodes preserves null bounds`() {
        val n = node(bounds = null)
        val scaled = UITreeUtils.scaleNodes(listOf(n), 0.5f)
        assertNull(scaled[0].bounds)
    }

    @Test
    fun `scaleNodes preserves other fields`() {
        val n = node(className = "android.widget.Button", resourceId = "com.app:id/btn")
        val scaled = UITreeUtils.scaleNodes(listOf(n), 0.5f)
        assertEquals("android.widget.Button", scaled[0].className)
        assertEquals("com.app:id/btn", scaled[0].resourceId)
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
