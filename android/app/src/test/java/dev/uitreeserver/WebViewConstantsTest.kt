package dev.uitreeserver

import org.junit.Assert.*
import org.junit.Test

class WebViewConstantsTest {

    @Test
    fun `roleClassMap contains common roles`() {
        assertNotNull(WebViewConstants.ROLE_CLASS_MAP["button"])
        assertNotNull(WebViewConstants.ROLE_CLASS_MAP["link"])
        assertNotNull(WebViewConstants.ROLE_CLASS_MAP["textbox"])
        assertNotNull(WebViewConstants.ROLE_CLASS_MAP["heading"])
        assertNotNull(WebViewConstants.ROLE_CLASS_MAP["checkbox"])
        assertNotNull(WebViewConstants.ROLE_CLASS_MAP["img"])
    }

    @Test
    fun `roleClassMap values have webview prefix`() {
        for ((_, value) in WebViewConstants.ROLE_CLASS_MAP) {
            assertTrue("Expected '$value' to start with 'webview.'", value.startsWith("webview."))
        }
    }

    @Test
    fun `clickableRoles contains expected`() {
        assertTrue(WebViewConstants.CLICKABLE_ROLES.contains("button"))
        assertTrue(WebViewConstants.CLICKABLE_ROLES.contains("link"))
        assertTrue(WebViewConstants.CLICKABLE_ROLES.contains("checkbox"))
        assertTrue(WebViewConstants.CLICKABLE_ROLES.contains("radio"))
    }

    @Test
    fun `clickableRoles does not contain non-clickable`() {
        assertFalse(WebViewConstants.CLICKABLE_ROLES.contains("heading"))
        assertFalse(WebViewConstants.CLICKABLE_ROLES.contains("paragraph"))
        assertFalse(WebViewConstants.CLICKABLE_ROLES.contains("table"))
    }

    @Test
    fun `extractScript is not blank`() {
        assertTrue(WebViewConstants.EXTRACT_SCRIPT.isNotBlank())
    }

    @Test
    fun `extractScript contains devicePixelRatio`() {
        assertTrue(WebViewConstants.EXTRACT_SCRIPT.contains("devicePixelRatio"))
    }
}
