package dev.uitreeserver

object InteractionUtils {

    // KeyEvent code values (stable Android API constants)
    val BUTTON_MAP: Map<String, Int> = mapOf(
        "home" to 3,          // KEYCODE_HOME
        "back" to 4,          // KEYCODE_BACK
        "volumeup" to 24,     // KEYCODE_VOLUME_UP
        "volumedown" to 25,   // KEYCODE_VOLUME_DOWN
        "enter" to 66,        // KEYCODE_ENTER
        "dpadup" to 19,       // KEYCODE_DPAD_UP
        "dpaddown" to 20,     // KEYCODE_DPAD_DOWN
        "dpadleft" to 21,     // KEYCODE_DPAD_LEFT
        "dpadright" to 22,    // KEYCODE_DPAD_RIGHT
        "dpadcenter" to 23    // KEYCODE_DPAD_CENTER
    )

    fun isValidPackageName(packageName: String): Boolean {
        return packageName.length <= 256 &&
            packageName.matches(Regex("^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z0-9_]+)+$"))
    }

    fun resolveButton(button: String): Pair<Int?, String?> {
        val keyCode = BUTTON_MAP[button.lowercase()]
        if (keyCode == null) {
            val validButtons = BUTTON_MAP.keys.sorted().joinToString(", ")
            return Pair(null, "Unknown button '$button'. Valid buttons: $validButtons")
        }
        return Pair(keyCode, null)
    }
}
