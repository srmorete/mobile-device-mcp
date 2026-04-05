package dev.uitreeserver

import org.junit.Assert.*
import org.junit.Test

class WebViewUtilsTest {

    private fun node(
        resourceId: String? = null,
        bounds: Bounds? = Bounds(0, 0, 100, 50),
        children: List<UITreeNode> = emptyList()
    ) = UITreeNode(
        className = "android.view.View", text = null, hintText = null, contentDesc = null,
        resourceId = resourceId, packageName = null, bounds = bounds,
        checkable = false, checked = false, clickable = false, enabled = true,
        focusable = false, focused = false, scrollable = false, longClickable = false,
        password = false, selected = false, visibleToUser = true, children = children
    )

    @Test
    fun `chromeCCT with toolbar uses toolbar bottom`() {
        val toolbar = node(resourceId = "com.android.chrome:id/toolbar", bounds = Bounds(0, 0, 1080, 200))
        val container = WebViewContainer(
            node(resourceId = "com.android.chrome:id/compositor_view_holder"),
            isChromeCCT = true
        )
        val origin = WebViewUtils.resolveViewportOrigin(container, listOf(toolbar))
        assertEquals(ViewportOrigin(0, 200), origin)
    }

    @Test
    fun `chromeCCT without toolbar falls back to container bounds`() {
        val containerNode = node(bounds = Bounds(0, 150, 1080, 1920))
        val container = WebViewContainer(containerNode, isChromeCCT = true)
        val origin = WebViewUtils.resolveViewportOrigin(container, emptyList())
        assertEquals(ViewportOrigin(0, 150), origin)
    }

    @Test
    fun `regular webview uses container bounds`() {
        val containerNode = node(bounds = Bounds(50, 100, 500, 800))
        val container = WebViewContainer(containerNode, isChromeCCT = false)
        val origin = WebViewUtils.resolveViewportOrigin(container, emptyList())
        assertEquals(ViewportOrigin(50, 100), origin)
    }

    @Test
    fun `no bounds returns zero zero`() {
        val containerNode = node(bounds = null)
        val container = WebViewContainer(containerNode, isChromeCCT = false)
        val origin = WebViewUtils.resolveViewportOrigin(container, emptyList())
        assertEquals(ViewportOrigin(0, 0), origin)
    }
}
