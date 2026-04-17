package dev.uitreeserver

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.abs

class CoordTest {

    private fun node(
        bounds: Bounds? = Bounds(0, 0, 100, 50),
        children: List<UITreeNode> = emptyList()
    ) = UITreeNode(
        className = "android.widget.View", text = null, hintText = null, contentDesc = null,
        resourceId = null, packageName = null, bounds = bounds,
        checkable = false, checked = false, clickable = false, enabled = true,
        focusable = false, focused = false, scrollable = false, longClickable = false,
        password = false, selected = false, visibleToUser = true, children = children
    )

    // --- compute ---

    @Test
    fun `compute downscale large device`() {
        // 1080 x 2400 → max=2400 → 1500/2400 = 0.625
        val c = Coord.compute(1080, 2400)
        assertEquals(0.625f, c.renderScale, 0.0001f)
    }

    @Test
    fun `compute upscale small device`() {
        // 375 x 667 (iPhone SE in points) → max=667 → 1500/667 ≈ 2.249
        val c = Coord.compute(375, 667)
        assertEquals(1500f / 667f, c.renderScale, 0.0001f)
        assertTrue(c.renderScale > 1.0f)
    }

    @Test
    fun `compute rotation invariant via max`() {
        val portrait = Coord.compute(1080, 2400)
        val landscape = Coord.compute(2400, 1080)
        assertEquals(portrait.renderScale, landscape.renderScale, 0f)
    }

    @Test
    fun `compute zero dims yields identity`() {
        assertEquals(1.0f, Coord.compute(0, 0).renderScale, 0f)
        assertEquals(1.0f, Coord.compute(0, 100).renderScale, 0f)
        assertEquals(1.0f, Coord.compute(100, 0).renderScale, 0f)
    }

    @Test
    fun `compute negative dims yields identity`() {
        assertEquals(1.0f, Coord.compute(-5, -10).renderScale, 0f)
    }

    @Test
    fun `compute exactly at target is identity`() {
        val c = Coord.compute(800, 1500)
        assertEquals(1.0f, c.renderScale, 0.0001f)
    }

    // --- toRender / toNative ---

    @Test
    fun `toRenderInt scales up`() {
        val c = Coord(2.0f)
        assertEquals(200, c.toRenderInt(100))
    }

    @Test
    fun `toNativeInt scales down`() {
        val c = Coord(0.5f)
        assertEquals(200, c.toNativeInt(100f))
    }

    @Test
    fun `roundtrip within one pixel for realistic device scales`() {
        // Invariant: |toNative(toRender(n)) - n| <= 1 for realistic mobile scales.
        // Bound holds when scale >= 0.5 (Android/iOS real devices sit in [0.4, 2.5]).
        // At smaller scales a single render pixel spans >2 native pixels so rounding
        // error grows accordingly — out of scope for any real device today.
        val scales = floatArrayOf(0.625f, 1500f / 667f, 1500f / 932f, 1.0f)
        for (scale in scales) {
            val c = Coord(scale)
            for (n in 0..3000 step 7) {
                val round = c.toNativeInt(c.toRenderInt(n).toFloat())
                assertTrue(
                    "scale=$scale n=$n round=$round",
                    abs(round - n) <= 1
                )
            }
        }
    }

    // --- scaleBounds / scaleNodes ---

    @Test
    fun `scaleBounds identity unchanged`() {
        val b = Bounds(10, 20, 90, 80)
        assertEquals(b, Coord(1.0f).scaleBounds(b))
    }

    @Test
    fun `scaleBounds scales down`() {
        val b = Bounds(100, 200, 300, 400)
        assertEquals(Bounds(50, 100, 150, 200), Coord(0.5f).scaleBounds(b))
    }

    @Test
    fun `scaleNodes recurses and preserves null bounds`() {
        val child = node(bounds = Bounds(50, 50, 100, 100))
        val nullChild = node(bounds = null)
        val parent = node(bounds = Bounds(0, 0, 200, 200), children = listOf(child, nullChild))
        val scaled = Coord(0.5f).scaleNodes(listOf(parent))
        assertEquals(Bounds(0, 0, 100, 100), scaled[0].bounds)
        assertEquals(Bounds(25, 25, 50, 50), scaled[0].children[0].bounds)
        assertNull(scaled[0].children[1].bounds)
    }

    @Test
    fun `scaleNodes preserves non-coord fields`() {
        val n = UITreeNode(
            className = "android.widget.Button", text = "ok", hintText = "hint",
            contentDesc = "desc", resourceId = "r", packageName = "p",
            bounds = Bounds(0, 0, 100, 50),
            checkable = true, checked = true, clickable = true, enabled = false,
            focusable = true, focused = true, scrollable = true, longClickable = true,
            password = true, selected = true, visibleToUser = false,
            children = emptyList(), source = "webview"
        )
        val out = Coord(0.5f).scaleNodes(listOf(n))[0]
        assertEquals("android.widget.Button", out.className)
        assertEquals("ok", out.text)
        assertTrue(out.clickable)
        assertEquals("webview", out.source)
    }
}
