package dev.uitreeserver

import org.junit.Assert.*
import org.junit.Test

class InteractionUtilsTest {

    // --- BUTTON_MAP ---

    @Test
    fun `buttonMap contains all expected buttons`() {
        val expected = setOf("home", "back", "volumeup", "volumedown", "enter",
            "dpadup", "dpaddown", "dpadleft", "dpadright", "dpadcenter")
        assertEquals(expected, InteractionUtils.BUTTON_MAP.keys)
    }

    @Test
    fun `buttonMap values match Android KeyEvent codes`() {
        assertEquals(3, InteractionUtils.BUTTON_MAP["home"])     // KEYCODE_HOME
        assertEquals(4, InteractionUtils.BUTTON_MAP["back"])     // KEYCODE_BACK
        assertEquals(24, InteractionUtils.BUTTON_MAP["volumeup"])
        assertEquals(25, InteractionUtils.BUTTON_MAP["volumedown"])
        assertEquals(66, InteractionUtils.BUTTON_MAP["enter"])   // KEYCODE_ENTER
    }

    // --- isValidPackageName ---

    @Test
    fun `valid package name`() {
        assertTrue(InteractionUtils.isValidPackageName("com.example.app"))
    }

    @Test
    fun `valid package name with underscores`() {
        assertTrue(InteractionUtils.isValidPackageName("com.my_app.test_2"))
    }

    @Test
    fun `single segment invalid`() {
        assertFalse(InteractionUtils.isValidPackageName("noperiod"))
    }

    @Test
    fun `starts with digit invalid`() {
        assertFalse(InteractionUtils.isValidPackageName("1com.example"))
    }

    @Test
    fun `empty string invalid`() {
        assertFalse(InteractionUtils.isValidPackageName(""))
    }

    @Test
    fun `too long invalid`() {
        val longName = "a" + ".b".repeat(128)
        assertFalse(InteractionUtils.isValidPackageName(longName))
    }

    @Test
    fun `special characters invalid`() {
        assertFalse(InteractionUtils.isValidPackageName("com.example.app!"))
    }

    @Test
    fun `dash invalid`() {
        assertFalse(InteractionUtils.isValidPackageName("com.my-app.test"))
    }

    // --- resolveButton ---

    @Test
    fun `resolveButton valid returns keycode`() {
        val (keyCode, error) = InteractionUtils.resolveButton("home")
        assertEquals(3, keyCode)
        assertNull(error)
    }

    @Test
    fun `resolveButton case insensitive`() {
        val (keyCode, _) = InteractionUtils.resolveButton("HOME")
        assertEquals(3, keyCode)
    }

    @Test
    fun `resolveButton unknown returns error with valid list`() {
        val (keyCode, error) = InteractionUtils.resolveButton("power")
        assertNull(keyCode)
        assertNotNull(error)
        assertTrue(error!!.contains("home"))
        assertTrue(error.contains("back"))
    }
}
