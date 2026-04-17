package dev.uitreeserver

/**
 * Single source of coordinate calculation between native device pixels and render space.
 *
 * Render space is the unified coordinate system exposed by all server endpoints:
 * screenshot pixels, UI tree bounds, /tap /scroll /longPress inputs, and /exec bindings.
 * Conversion to native happens at the handler edge before dispatching to UIAutomator.
 *
 * `renderScale = TARGET_LONG_EDGE / max(nativeWidth, nativeHeight)`
 * max() makes the scale rotation-invariant so a single value is valid for the server's
 * lifetime even when the device rotates. Zero or unknown dims yield identity (1.0).
 */
class Coord(val renderScale: Float) {

    fun toRender(v: Float): Float = v * renderScale
    fun toRenderInt(v: Int): Int = Math.round(v * renderScale)

    fun toNative(v: Float): Float = v / renderScale
    // toNative then round-to-Int introduces ±1 rounding. UIAutomator takes ints, so
    // the asymmetry vs iOS (Double, bit-exact round-trip) is intentional; callers that
    // need sub-pixel precision should stage on Float and round once at the final native hop.
    fun toNativeInt(v: Float): Int = Math.round(v / renderScale)

    fun scaleBounds(b: Bounds): Bounds = Bounds(
        toRenderInt(b.left),
        toRenderInt(b.top),
        toRenderInt(b.right),
        toRenderInt(b.bottom)
    )

    fun scaleNodes(nodes: List<UITreeNode>): List<UITreeNode> = nodes.map { node ->
        node.copy(
            bounds = node.bounds?.let { scaleBounds(it) },
            children = scaleNodes(node.children)
        )
    }

    companion object {
        /** Longer-side target in render pixels. Keeps images below the 1568 vision
         *  resize threshold and the 2000 per-dimension many-image cap. */
        const val TARGET_LONG_EDGE = 1500

        fun compute(nativeW: Int, nativeH: Int): Coord {
            // Identity if either dim is missing/invalid — avoids a misleading scale
            // derived from only one known side.
            if (nativeW <= 0 || nativeH <= 0) return Coord(1.0f)
            return Coord(TARGET_LONG_EDGE.toFloat() / maxOf(nativeW, nativeH).toFloat())
        }
    }
}
