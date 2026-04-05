package dev.uitreeserver

object UITreeUtils {

    fun clipBounds(left: Int, top: Int, right: Int, bottom: Int, screenWidth: Int, screenHeight: Int): Bounds {
        return Bounds(
            left = left.coerceIn(0, screenWidth),
            top = top.coerceIn(0, screenHeight),
            right = right.coerceIn(0, screenWidth),
            bottom = bottom.coerceIn(0, screenHeight)
        )
    }

    fun findWebViewContainers(nodes: List<UITreeNode>): List<WebViewContainer> {
        val results = mutableListOf<WebViewContainer>()
        for (node in nodes) {
            findWebViewContainersRecursive(node, results)
        }
        return results
    }

    private fun findWebViewContainersRecursive(node: UITreeNode, results: MutableList<WebViewContainer>) {
        if (node.className == "android.webkit.WebView") {
            results.add(WebViewContainer(node, isChromeCCT = false))
        } else if (node.resourceId == "com.android.chrome:id/compositor_view_holder") {
            results.add(WebViewContainer(node, isChromeCCT = true))
        }
        for (child in node.children) {
            findWebViewContainersRecursive(child, results)
        }
    }

    fun augmentTreeWithWebViewNodes(
        nodes: List<UITreeNode>,
        webviewChildren: Map<UITreeNode, List<UITreeNode>>
    ): List<UITreeNode> {
        return nodes.map { augmentNode(it, webviewChildren) }
    }

    private fun augmentNode(
        node: UITreeNode,
        webviewChildren: Map<UITreeNode, List<UITreeNode>>
    ): UITreeNode {
        val extraChildren = webviewChildren[node]
        val updatedChildren = node.children.map { augmentNode(it, webviewChildren) }
        return if (extraChildren != null) {
            node.copy(children = updatedChildren + extraChildren)
        } else {
            node.copy(children = updatedChildren)
        }
    }

    fun scaleBounds(bounds: Bounds, scale: Float): Bounds = Bounds(
        left = Math.round(bounds.left * scale),
        top = Math.round(bounds.top * scale),
        right = Math.round(bounds.right * scale),
        bottom = Math.round(bounds.bottom * scale)
    )

    fun scaleNodes(nodes: List<UITreeNode>, scale: Float): List<UITreeNode> {
        return nodes.map { node ->
            node.copy(
                bounds = node.bounds?.let { scaleBounds(it, scale) },
                children = scaleNodes(node.children, scale)
            )
        }
    }

    fun findNodeByResourceId(nodes: List<UITreeNode>, resourceId: String): UITreeNode? {
        for (node in nodes) {
            if (node.resourceId == resourceId) return node
            val found = findNodeByResourceId(node.children, resourceId)
            if (found != null) return found
        }
        return null
    }
}
