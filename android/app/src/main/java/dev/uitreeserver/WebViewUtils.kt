package dev.uitreeserver

object WebViewUtils {

    fun resolveViewportOrigin(
        container: WebViewContainer,
        nativeNodes: List<UITreeNode>
    ): ViewportOrigin {
        if (container.isChromeCCT) {
            val toolbar = UITreeUtils.findNodeByResourceId(nativeNodes, "com.android.chrome:id/toolbar")
            if (toolbar?.bounds != null) {
                return ViewportOrigin(0, toolbar.bounds.bottom)
            }
        }

        val bounds = container.node.bounds
        if (bounds != null) {
            return ViewportOrigin(bounds.left, bounds.top)
        }

        return ViewportOrigin(0, 0)
    }
}
