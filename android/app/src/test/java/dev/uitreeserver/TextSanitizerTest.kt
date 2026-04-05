package dev.uitreeserver

import org.junit.Assert.*
import org.junit.Test

class TextSanitizerTest {

    @Test
    fun `null returns null`() {
        assertNull(TextSanitizer.sanitize(null))
    }

    @Test
    fun `empty string returns null`() {
        assertNull(TextSanitizer.sanitize(""))
    }

    @Test
    fun `normal ASCII text unchanged`() {
        assertEquals("Hello World", TextSanitizer.sanitize("Hello World"))
    }

    @Test
    fun `preserves tab newline and CR`() {
        assertEquals("a\tb\nc\r", TextSanitizer.sanitize("a\tb\nc\r"))
    }

    @Test
    fun `replaces U0001 through U0008 with dots`() {
        val input = "\u0001\u0004\u0008"
        assertEquals("...", TextSanitizer.sanitize(input))
    }

    @Test
    fun `replaces U000B and U000C`() {
        val input = "a\u000Bb\u000Cc"
        assertEquals("a.b.c", TextSanitizer.sanitize(input))
    }

    @Test
    fun `replaces U000E through U001F`() {
        val input = "\u000E\u001F"
        assertEquals("..", TextSanitizer.sanitize(input))
    }

    @Test
    fun `replaces U007F through U0084`() {
        val input = "\u007F\u0080\u0084"
        assertEquals("...", TextSanitizer.sanitize(input))
    }

    @Test
    fun `preserves U0085 (NEL)`() {
        assertEquals("\u0085", TextSanitizer.sanitize("\u0085"))
    }

    @Test
    fun `replaces U0086 through U009F`() {
        val input = "\u0086\u0090\u009F"
        assertEquals("...", TextSanitizer.sanitize(input))
    }

    @Test
    fun `replaces UFDD0 through UFDEF`() {
        val input = "\uFDD0\uFDE0\uFDEF"
        assertEquals("...", TextSanitizer.sanitize(input))
    }

    @Test
    fun `mixed valid and invalid characters`() {
        val input = "Hello\u0001World\u0002!"
        assertEquals("Hello.World.!", TextSanitizer.sanitize(input))
    }

    @Test
    fun `only invalid chars returns dots not null`() {
        // All replaced with dots — result is "..." which is non-empty
        val input = "\u0001\u0002\u0003"
        assertEquals("...", TextSanitizer.sanitize(input))
    }
}
