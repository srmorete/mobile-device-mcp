package dev.uitreeserver

import com.google.gson.JsonNull
import org.junit.Assert.*
import org.junit.Test

class UITreeSerializerTest {

    private fun leaf(
        className: String? = "android.widget.Button",
        text: String? = "Click me",
        bounds: Bounds? = Bounds(10, 20, 110, 70),
        children: List<UITreeNode> = emptyList(),
        source: String = "native"
    ) = UITreeNode(
        className = className, text = text, hintText = null, contentDesc = null,
        resourceId = null, packageName = null, bounds = bounds,
        checkable = false, checked = false, clickable = true, enabled = true,
        focusable = false, focused = false, scrollable = false, longClickable = false,
        password = false, selected = false, visibleToUser = true,
        children = children, source = source
    )

    @Test
    fun `serializeNode includes all fields`() {
        val json = UITreeSerializer.serializeNode(leaf())
        assertEquals("android.widget.Button", json.get("className").asString)
        assertEquals("Click me", json.get("text").asString)
        assertTrue(json.get("clickable").asBoolean)
        assertEquals("native", json.get("source").asString)
    }

    @Test
    fun `serializeNode null fields become JsonNull`() {
        val json = UITreeSerializer.serializeNode(leaf(className = null, text = null))
        assertTrue(json.get("className").isJsonNull)
        assertTrue(json.get("text").isJsonNull)
    }

    @Test
    fun `serializeNode null bounds become JsonNull`() {
        val json = UITreeSerializer.serializeNode(leaf(bounds = null))
        assertTrue(json.get("bounds").isJsonNull)
    }

    @Test
    fun `serializeNode bounds serialized correctly`() {
        val json = UITreeSerializer.serializeNode(leaf())
        val bounds = json.getAsJsonObject("bounds")
        assertEquals(10, bounds.get("left").asInt)
        assertEquals(20, bounds.get("top").asInt)
        assertEquals(110, bounds.get("right").asInt)
        assertEquals(70, bounds.get("bottom").asInt)
    }

    @Test
    fun `serializeNode children serialized recursively`() {
        val child = leaf(className = "android.widget.TextView", text = "child")
        val parent = leaf(children = listOf(child))
        val json = UITreeSerializer.serializeNode(parent)
        val children = json.getAsJsonArray("children")
        assertEquals(1, children.size())
        assertEquals("android.widget.TextView", children[0].asJsonObject.get("className").asString)
    }

    @Test
    fun `serializeNodes empty list`() {
        val arr = UITreeSerializer.serializeNodes(emptyList())
        assertEquals(0, arr.size())
    }

    @Test
    fun `serializeNode source field present`() {
        val json = UITreeSerializer.serializeNode(leaf(source = "webview"))
        assertEquals("webview", json.get("source").asString)
    }
}
