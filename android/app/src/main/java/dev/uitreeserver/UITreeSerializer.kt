package dev.uitreeserver

import com.google.gson.JsonArray
import com.google.gson.JsonNull
import com.google.gson.JsonObject

object UITreeSerializer {

    fun serializeNodes(nodes: List<UITreeNode>): JsonArray {
        val array = JsonArray()
        for (node in nodes) {
            array.add(serializeNode(node))
        }
        return array
    }

    fun serializeNode(node: UITreeNode): JsonObject {
        return JsonObject().apply {
            addPropertyOrNull("className", node.className)
            addPropertyOrNull("text", node.text)
            addPropertyOrNull("hintText", node.hintText)
            addPropertyOrNull("contentDesc", node.contentDesc)
            addPropertyOrNull("resourceId", node.resourceId)
            addPropertyOrNull("packageName", node.packageName)

            if (node.bounds != null) {
                add("bounds", JsonObject().apply {
                    addProperty("left", node.bounds.left)
                    addProperty("top", node.bounds.top)
                    addProperty("right", node.bounds.right)
                    addProperty("bottom", node.bounds.bottom)
                })
            } else {
                add("bounds", JsonNull.INSTANCE)
            }

            addProperty("checkable", node.checkable)
            addProperty("checked", node.checked)
            addProperty("clickable", node.clickable)
            addProperty("enabled", node.enabled)
            addProperty("focusable", node.focusable)
            addProperty("focused", node.focused)
            addProperty("scrollable", node.scrollable)
            addProperty("longClickable", node.longClickable)
            addProperty("password", node.password)
            addProperty("selected", node.selected)
            addProperty("visibleToUser", node.visibleToUser)

            add("children", serializeNodes(node.children))
            addProperty("source", node.source)
        }
    }

    private fun JsonObject.addPropertyOrNull(name: String, value: String?) {
        if (value != null) {
            addProperty(name, value)
        } else {
            add(name, JsonNull.INSTANCE)
        }
    }
}
