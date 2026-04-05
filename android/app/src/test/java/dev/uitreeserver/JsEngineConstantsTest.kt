package dev.uitreeserver

import org.junit.Assert.*
import org.junit.Test

class JsEngineConstantsTest {

    @Test
    fun `reflection classes blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("java.lang.reflect.Method"))
        assertFalse(JsEngineConstants.isClassAllowed("java.lang.reflect.Field"))
    }

    @Test
    fun `Runtime blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("java.lang.Runtime"))
    }

    @Test
    fun `Process blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("java.lang.ProcessBuilder"))
    }

    @Test
    fun `System blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("java.lang.System"))
    }

    @Test
    fun `io blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("java.io.File"))
        assertFalse(JsEngineConstants.isClassAllowed("java.io.FileInputStream"))
    }

    @Test
    fun `nio blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("java.nio.file.Files"))
    }

    @Test
    fun `net blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("java.net.Socket"))
        assertFalse(JsEngineConstants.isClassAllowed("javax.net.ssl.SSLSocket"))
    }

    @Test
    fun `okhttp blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("okhttp3.OkHttpClient"))
    }

    @Test
    fun `UIAutomator allowed`() {
        assertTrue(JsEngineConstants.isClassAllowed("androidx.test.uiautomator.UiDevice"))
        assertTrue(JsEngineConstants.isClassAllowed("androidx.test.uiautomator.By"))
    }

    @Test
    fun `safe stdlib classes allowed`() {
        assertTrue(JsEngineConstants.isClassAllowed("java.lang.String"))
        assertTrue(JsEngineConstants.isClassAllowed("java.lang.Math"))
        assertTrue(JsEngineConstants.isClassAllowed("java.util.ArrayList"))
        assertTrue(JsEngineConstants.isClassAllowed("java.util.regex.Pattern"))
    }

    @Test
    fun `android graphics allowed`() {
        assertTrue(JsEngineConstants.isClassAllowed("android.graphics.Point"))
        assertTrue(JsEngineConstants.isClassAllowed("android.graphics.Rect"))
    }

    @Test
    fun `unknown class blocked`() {
        assertFalse(JsEngineConstants.isClassAllowed("com.evil.Hacker"))
        assertFalse(JsEngineConstants.isClassAllowed("some.random.Class"))
    }

    @Test
    fun `blockedMethods contains getClass`() {
        assertTrue(JsEngineConstants.BLOCKED_METHODS.contains("getClass"))
        assertTrue(JsEngineConstants.BLOCKED_METHODS.contains("forName"))
        assertTrue(JsEngineConstants.BLOCKED_METHODS.contains("getClassLoader"))
    }

    @Test
    fun `maxInstructions value`() {
        assertEquals(10_000_000, JsEngineConstants.MAX_INSTRUCTIONS)
    }
}
