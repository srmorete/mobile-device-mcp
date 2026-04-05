package dev.uitreeserver

/**
 * Sanitizes text for XML 1.1 compliance by replacing control characters
 * with '.' while preserving tab (U+0009), newline (U+000A), and CR (U+000D).
 *
 * Returns null if the result is empty after sanitization.
 */
object TextSanitizer {

    fun sanitize(text: String?): String? {
        if (text == null) return null
        val sb = StringBuilder(text.length)
        for (ch in text) {
            val code = ch.code
            if (isInvalidXml11Char(code)) {
                sb.append('.')
            } else {
                sb.append(ch)
            }
        }
        val result = sb.toString()
        return result.ifEmpty { null }
    }

    private fun isInvalidXml11Char(code: Int): Boolean {
        // U+0001-U+0008
        if (code in 0x0001..0x0008) return true
        // U+000B-U+000C
        if (code in 0x000B..0x000C) return true
        // U+000E-U+001F
        if (code in 0x000E..0x001F) return true
        // U+007F-U+0084
        if (code in 0x007F..0x0084) return true
        // U+0086-U+009F
        if (code in 0x0086..0x009F) return true
        // U+FDD0-U+FDEF
        if (code in 0xFDD0..0xFDEF) return true
        return false
    }
}
