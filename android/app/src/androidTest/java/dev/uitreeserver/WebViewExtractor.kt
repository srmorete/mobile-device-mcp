package dev.uitreeserver

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/**
 * Extracts semantic content from WebViews via Chrome DevTools Protocol.
 * Uses a single Runtime.evaluate call to extract roles, names, bounds,
 * and states from the DOM — no per-node CDP round-trips.
 */
class WebViewExtractor(private val cdpClient: CdpClient) {

    /**
     * Extracts WebView content from all discovered CDP targets and
     * returns UITreeNodes to augment the native tree.
     */
    fun extractWebViewNodes(
        containers: List<WebViewContainer>,
        nativeNodes: List<UITreeNode>,
        screenWidth: Int,
        screenHeight: Int
    ): Map<UITreeNode, List<UITreeNode>> {
        val targets = cdpClient.discoverTargets()
        android.util.Log.d("WebViewExtractor", "CDP targets: ${targets.size} found${targets.map { " [${it.type}] ${it.url}" }}")
        if (targets.isEmpty()) return emptyMap()

        android.util.Log.d("WebViewExtractor", "WebView containers: ${containers.size}")

        val result = mutableMapOf<UITreeNode, List<UITreeNode>>()

        for ((index, container) in containers.withIndex()) {
            val target = targets.getOrNull(index) ?: break
            val webviewNodes = extractFromTarget(
                target, container, nativeNodes, screenWidth, screenHeight
            )
            android.util.Log.d("WebViewExtractor", "extractFromTarget returned ${webviewNodes.size} nodes")
            if (webviewNodes.isNotEmpty()) {
                result[container.node] = webviewNodes
            }
        }

        return result
    }

    private fun extractFromTarget(
        target: CdpClient.CdpTarget,
        container: WebViewContainer,
        nativeNodes: List<UITreeNode>,
        screenWidth: Int,
        screenHeight: Int
    ): List<UITreeNode> {
        val wsUrl = target.webSocketDebuggerUrl
        val origin = WebViewUtils.resolveViewportOrigin(container, nativeNodes)

        val params = JsonObject().apply {
            addProperty("expression", WebViewConstants.EXTRACT_SCRIPT)
            addProperty("returnByValue", true)
        }
        val evalResult = cdpClient.sendCommand(wsUrl, "Runtime.evaluate", params) ?: return emptyList()

        if (evalResult.has("exceptionDetails")) return emptyList()
        val valueElement = evalResult.getAsJsonObject("result")?.get("value")
        if (valueElement == null || !valueElement.isJsonPrimitive) return emptyList()

        val elements = JsonParser.parseString(valueElement.asString).asJsonArray
        val treeNodes = mutableListOf<UITreeNode>()

        for (element in elements) {
            val obj = element.asJsonObject
            val role = obj.get("r")?.asString ?: continue
            val name = obj.get("n")?.takeIf { it.isJsonPrimitive }?.asString
            val desc = obj.get("d")?.takeIf { it.isJsonPrimitive }?.asString

            val left = (obj.get("l")?.asInt ?: continue) + origin.x
            val top = (obj.get("t")?.asInt ?: continue) + origin.y
            val right = (obj.get("ri")?.asInt ?: continue) + origin.x
            val bottom = (obj.get("b")?.asInt ?: continue) + origin.y

            val bounds = UITreeUtils.clipBounds(left, top, right, bottom, screenWidth, screenHeight)
            if (bounds.right - bounds.left <= 0 || bounds.bottom - bounds.top <= 0) continue

            val className = WebViewConstants.ROLE_CLASS_MAP[role] ?: "webview.Element"

            treeNodes.add(
                UITreeNode(
                    className = className,
                    text = TextSanitizer.sanitize(name),
                    hintText = null,
                    contentDesc = TextSanitizer.sanitize(desc),
                    resourceId = null,
                    packageName = null,
                    bounds = bounds,
                    checkable = obj.get("ca")?.asBoolean ?: false,
                    checked = obj.get("ch")?.asBoolean ?: false,
                    clickable = role in WebViewConstants.CLICKABLE_ROLES,
                    enabled = !(obj.get("di")?.asBoolean ?: false),
                    focusable = false,
                    focused = obj.get("fo")?.asBoolean ?: false,
                    scrollable = false,
                    longClickable = false,
                    password = obj.get("pw")?.asBoolean ?: false,
                    selected = obj.get("se")?.asBoolean ?: false,
                    visibleToUser = true,
                    children = emptyList(),
                    source = "webview"
                )
            )
        }

        return treeNodes
    }
}
