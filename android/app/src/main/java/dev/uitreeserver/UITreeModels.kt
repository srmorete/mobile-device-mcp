package dev.uitreeserver

data class Bounds(val left: Int, val top: Int, val right: Int, val bottom: Int)

data class UITreeNode(
    val className: String?,
    val text: String?,
    val hintText: String?,
    val contentDesc: String?,
    val resourceId: String?,
    val packageName: String?,
    val bounds: Bounds?,
    val checkable: Boolean,
    val checked: Boolean,
    val clickable: Boolean,
    val enabled: Boolean,
    val focusable: Boolean,
    val focused: Boolean,
    val scrollable: Boolean,
    val longClickable: Boolean,
    val password: Boolean,
    val selected: Boolean,
    val visibleToUser: Boolean,
    val children: List<UITreeNode>,
    val source: String = "native"
)

data class UITreeResponse(
    val rotation: Int,
    val screenWidth: Int,
    val screenHeight: Int,
    val nodes: List<UITreeNode>
)

data class WebViewContainer(
    val node: UITreeNode,
    val isChromeCCT: Boolean
)

data class ViewportOrigin(val x: Int, val y: Int)

data class ExecResult(val result: String, val logs: List<String>)
