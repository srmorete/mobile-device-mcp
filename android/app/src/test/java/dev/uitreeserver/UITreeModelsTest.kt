package dev.uitreeserver

import org.junit.Assert.*
import org.junit.Test

class UITreeModelsTest {

    private fun leaf(className: String? = "android.widget.Button", resourceId: String? = null) = UITreeNode(
        className = className, text = null, hintText = null, contentDesc = null,
        resourceId = resourceId, packageName = null, bounds = Bounds(0, 0, 100, 50),
        checkable = false, checked = false, clickable = true, enabled = true,
        focusable = false, focused = false, scrollable = false, longClickable = false,
        password = false, selected = false, visibleToUser = true, children = emptyList()
    )

    @Test
    fun `UITreeNode default source is native`() {
        assertEquals("native", leaf().source)
    }

    @Test
    fun `UITreeNode copy replaces children`() {
        val child = leaf()
        val parent = leaf().copy(children = listOf(child))
        assertEquals(1, parent.children.size)
        assertEquals(child, parent.children[0])
    }

    @Test
    fun `Bounds data class equality`() {
        assertEquals(Bounds(1, 2, 3, 4), Bounds(1, 2, 3, 4))
        assertNotEquals(Bounds(1, 2, 3, 4), Bounds(1, 2, 3, 5))
    }

    @Test
    fun `WebViewContainer data class equality`() {
        val node = leaf()
        assertEquals(
            WebViewContainer(node, isChromeCCT = true),
            WebViewContainer(node, isChromeCCT = true)
        )
    }

    @Test
    fun `ExecResult stores result and logs`() {
        val r = ExecResult("42", listOf("log1", "log2"))
        assertEquals("42", r.result)
        assertEquals(2, r.logs.size)
    }
}
