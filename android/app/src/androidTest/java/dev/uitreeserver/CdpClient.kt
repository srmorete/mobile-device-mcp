package dev.uitreeserver

import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.reflect.TypeToken
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Chrome DevTools Protocol client using raw WebSocket (RFC 6455).
 * Single connection per target, multiplexed by message ID, 5s command timeout.
 */
class CdpClient {

    companion object {
        private const val CDP_DISCOVERY_URL = "http://localhost:9222/json"
        private const val COMMAND_TIMEOUT_MS = 5000L
        private const val KEEP_ALIVE_MS = 10000L
        private const val MAX_PAYLOAD_SIZE = 16L * 1024 * 1024 // 16 MB
        private val gson = Gson()
    }

    data class CdpTarget(
        val id: String,
        val type: String,
        val title: String,
        val url: String,
        val webSocketDebuggerUrl: String
    )

    private val connections = ConcurrentHashMap<String, WebSocketConnection>()

    /**
     * Discovers CDP targets at localhost:9222.
     * Filters to page/webview types that have a webSocketDebuggerUrl, are visible and attached.
     */
    fun discoverTargets(): List<CdpTarget> {
        return try {
            val url = URL(CDP_DISCOVERY_URL)
            val conn = url.openConnection() as HttpURLConnection
            conn.connectTimeout = 3000
            conn.readTimeout = 3000
            conn.requestMethod = "GET"

            val response = conn.inputStream.bufferedReader().readText()
            conn.disconnect()

            val listType = object : TypeToken<List<JsonObject>>() {}.type
            val targets: List<JsonObject> = gson.fromJson(response, listType)

            targets.filter { target ->
                val type = target.get("type")?.asString ?: ""
                val wsUrl = target.get("webSocketDebuggerUrl")?.asString
                val visible = target.get("visible")?.let { if (it.isJsonPrimitive) it.asBoolean else true } ?: true
                val attached = target.get("attached")?.let { if (it.isJsonPrimitive) it.asBoolean else true } ?: true
                (type == "page" || type == "webview") && !wsUrl.isNullOrBlank() && visible && attached
            }.mapNotNull { target ->
                try {
                    CdpTarget(
                        id = target.get("id")?.asString ?: return@mapNotNull null,
                        type = target.get("type")?.asString ?: "",
                        title = target.get("title")?.asString ?: "",
                        url = target.get("url")?.asString ?: "",
                        webSocketDebuggerUrl = target.get("webSocketDebuggerUrl")?.asString ?: return@mapNotNull null
                    )
                } catch (_: Exception) {
                    null
                }
            }
        } catch (e: Exception) {
            android.util.Log.e("CdpClient", "discoverTargets failed: ${e.javaClass.simpleName}: ${e.message}", e)
            emptyList()
        }
    }

    /**
     * Sends a CDP command and waits for the result.
     */
    fun sendCommand(targetWsUrl: String, method: String, params: JsonObject? = null): JsonObject? {
        val connection = getOrCreateConnection(targetWsUrl) ?: return null
        return connection.sendCommand(method, params)
    }

    @Synchronized
    private fun getOrCreateConnection(wsUrl: String): WebSocketConnection? {
        val existing = connections[wsUrl]
        if (existing != null && existing.isConnected()) return existing

        // Close stale connection if present
        existing?.close()
        connections.remove(wsUrl)

        val conn = WebSocketConnection(wsUrl)
        if (conn.connect()) {
            connections[wsUrl] = conn
            return conn
        }
        return null
    }

    @Synchronized
    fun closeAll() {
        for ((_, conn) in connections) {
            conn.close()
        }
        connections.clear()
    }

    /**
     * Minimal WebSocket client implementing RFC 6455 over a plain TCP socket.
     * Only supports text frames and the CDP JSON protocol.
     */
    private class WebSocketConnection(private val wsUrl: String) {
        private val messageId = AtomicInteger(0)
        private val pendingCommands = ConcurrentHashMap<Int, PendingCommand>()
        private var socket: java.net.Socket? = null
        private var outputStream: OutputStream? = null
        @Volatile
        private var connected = false
        private var readerThread: Thread? = null

        data class PendingCommand(
            val latch: CountDownLatch = CountDownLatch(1),
            var result: JsonObject? = null,
            var error: JsonObject? = null
        )

        fun isConnected(): Boolean = connected

        fun connect(): Boolean {
            return try {
                val uri = URI(wsUrl)
                val host = uri.host ?: "localhost"
                val port = if (uri.port > 0) uri.port else 80
                val path = uri.rawPath + (if (uri.rawQuery != null) "?${uri.rawQuery}" else "")

                val sock = java.net.Socket()
                sock.connect(java.net.InetSocketAddress(host, port), 3000)
                sock.soTimeout = 0 // Non-blocking reads handled in thread
                socket = sock
                outputStream = sock.getOutputStream()

                // WebSocket handshake
                val key = android.util.Base64.encodeToString(
                    ByteArray(16).also { SecureRandom().nextBytes(it) },
                    android.util.Base64.NO_WRAP
                )
                val handshake = "GET $path HTTP/1.1\r\n" +
                    "Host: $host:$port\r\n" +
                    "Upgrade: websocket\r\n" +
                    "Connection: Upgrade\r\n" +
                    "Sec-WebSocket-Key: $key\r\n" +
                    "Sec-WebSocket-Version: 13\r\n" +
                    "\r\n"

                outputStream!!.write(handshake.toByteArray())
                outputStream!!.flush()

                // Read handshake response
                val inputStream = sock.getInputStream()
                val headerBuilder = StringBuilder()
                var prevByte = -1
                var crlfCount = 0
                while (crlfCount < 2) {
                    val b = inputStream.read()
                    if (b == -1) return false
                    headerBuilder.append(b.toChar())
                    if (b == 0x0A && prevByte == 0x0D) {
                        crlfCount++
                    } else if (b != 0x0D) {
                        crlfCount = 0
                    }
                    prevByte = b
                }

                val responseHeader = headerBuilder.toString()
                if (!responseHeader.contains("101")) {
                    sock.close()
                    return false
                }

                connected = true

                // Start reader thread
                readerThread = Thread {
                    readLoop(inputStream)
                }.apply {
                    isDaemon = true
                    name = "cdp-ws-reader"
                    start()
                }

                true
            } catch (e: Exception) {
                connected = false
                false
            }
        }

        private fun readLoop(inputStream: java.io.InputStream) {
            try {
                while (connected) {
                    val frame = readFrame(inputStream) ?: break
                    handleMessage(frame)
                }
            } catch (_: Exception) {
                // Connection closed
            } finally {
                connected = false
                // Unblock all pending commands
                for ((_, pending) in pendingCommands) {
                    pending.latch.countDown()
                }
            }
        }

        private fun readSingleFrame(inputStream: java.io.InputStream): RawFrame? {
            val byte1 = inputStream.read()
            if (byte1 == -1) return null

            val byte2 = inputStream.read()
            if (byte2 == -1) return null

            val fin = (byte1 and 0x80) != 0
            val opcode = byte1 and 0x0F
            val masked = (byte2 and 0x80) != 0
            var payloadLength = (byte2 and 0x7F).toLong()

            if (payloadLength == 126L) {
                val b1 = inputStream.read()
                val b2 = inputStream.read()
                if (b1 == -1 || b2 == -1) return null
                payloadLength = ((b1 shl 8) or b2).toLong()
            } else if (payloadLength == 127L) {
                var len = 0L
                for (i in 0 until 8) {
                    val b = inputStream.read()
                    if (b == -1) return null
                    len = (len shl 8) or b.toLong()
                }
                payloadLength = len
            }

            val maskKey = if (masked) {
                ByteArray(4).also { buf ->
                    var read = 0
                    while (read < 4) {
                        val n = inputStream.read(buf, read, 4 - read)
                        if (n == -1) return null
                        read += n
                    }
                }
            } else null

            if (payloadLength > MAX_PAYLOAD_SIZE) return null
            val payload = ByteArray(payloadLength.toInt())
            var read = 0
            while (read < payloadLength) {
                val n = inputStream.read(payload, read, (payloadLength - read).toInt())
                if (n == -1) return null
                read += n
            }

            if (maskKey != null) {
                for (i in payload.indices) {
                    payload[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
                }
            }

            return RawFrame(fin, opcode, payload)
        }

        private data class RawFrame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

        private fun readFrame(inputStream: java.io.InputStream): String? {
            while (true) {
                val frame = readSingleFrame(inputStream) ?: return null

                // Handle connection close frame
                if (frame.opcode == 0x8) {
                    connected = false
                    return null
                }

                // Handle ping — respond with pong, then continue to next frame
                if (frame.opcode == 0x9) {
                    sendPong(frame.payload)
                    continue
                }

                // Skip pong frames
                if (frame.opcode == 0xA) continue

                // Text (0x1) or binary (0x2) — start of a message
                if (frame.opcode != 0x1 && frame.opcode != 0x2) continue

                // If FIN is set, the message is complete in a single frame
                if (frame.fin) {
                    return String(frame.payload, Charsets.UTF_8)
                }

                // Fragmented message: accumulate continuation frames until FIN
                val buffer = java.io.ByteArrayOutputStream()
                buffer.write(frame.payload)
                while (true) {
                    val cont = readSingleFrame(inputStream) ?: return null
                    // Control frames (ping/pong/close) can interleave fragments
                    if (cont.opcode == 0x8) { connected = false; return null }
                    if (cont.opcode == 0x9) { sendPong(cont.payload); continue }
                    if (cont.opcode == 0xA) continue
                    // Continuation frame (opcode 0x0)
                    if (buffer.size() + cont.payload.size > MAX_PAYLOAD_SIZE) return null
                    buffer.write(cont.payload)
                    if (cont.fin) break
                }
                return String(buffer.toByteArray(), Charsets.UTF_8)
            }
        }

        private fun handleMessage(message: String) {
            try {
                val json = JsonParser.parseString(message).asJsonObject
                val id = json.get("id")?.asInt ?: return // Ignore events

                val pending = pendingCommands[id] ?: return
                if (json.has("error")) {
                    pending.error = json.getAsJsonObject("error")
                } else {
                    pending.result = json.getAsJsonObject("result")
                }
                pending.latch.countDown()
            } catch (_: Exception) {
                // Ignore malformed messages
            }
        }

        fun sendCommand(method: String, params: JsonObject?): JsonObject? {
            if (!connected) return null

            val id = messageId.incrementAndGet()
            val command = JsonObject().apply {
                addProperty("id", id)
                addProperty("method", method)
                if (params != null) add("params", params)
            }

            val pending = PendingCommand()
            pendingCommands[id] = pending

            try {
                sendTextFrame(gson.toJson(command))

                if (!pending.latch.await(COMMAND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                    pendingCommands.remove(id)
                    return null
                }

                pendingCommands.remove(id)
                if (pending.error != null) return null
                return pending.result
            } catch (_: Exception) {
                pendingCommands.remove(id)
                return null
            }
        }

        @Synchronized
        private fun sendTextFrame(text: String) {
            val out = outputStream ?: return
            val payload = text.toByteArray(Charsets.UTF_8)
            val mask = ByteArray(4).also { SecureRandom().nextBytes(it) }

            // FIN + text opcode
            out.write(0x81)

            // Masked + payload length
            if (payload.size < 126) {
                out.write(0x80 or payload.size)
            } else if (payload.size < 65536) {
                out.write(0x80 or 126)
                out.write((payload.size shr 8) and 0xFF)
                out.write(payload.size and 0xFF)
            } else {
                out.write(0x80 or 127)
                for (i in 7 downTo 0) {
                    out.write((payload.size.toLong() shr (i * 8)).toInt() and 0xFF)
                }
            }

            // Mask key
            out.write(mask)

            // Masked payload
            for (i in payload.indices) {
                out.write(payload[i].toInt() xor mask[i % 4].toInt())
            }
            out.flush()
        }

        @Synchronized
        private fun sendPong(payload: ByteArray) {
            val out = outputStream ?: return
            val mask = ByteArray(4).also { SecureRandom().nextBytes(it) }

            // FIN + pong opcode
            out.write(0x8A)

            // Masked + payload length (extended encoding for >= 126 bytes)
            if (payload.size < 126) {
                out.write(0x80 or payload.size)
            } else if (payload.size < 65536) {
                out.write(0x80 or 126)
                out.write((payload.size shr 8) and 0xFF)
                out.write(payload.size and 0xFF)
            } else {
                out.write(0x80 or 127)
                for (i in 7 downTo 0) {
                    out.write((payload.size.toLong() shr (i * 8)).toInt() and 0xFF)
                }
            }

            out.write(mask)
            for (i in payload.indices) {
                out.write(payload[i].toInt() xor mask[i % 4].toInt())
            }
            out.flush()
        }

        fun close() {
            connected = false
            try {
                socket?.close()
            } catch (_: Exception) {}
            readerThread?.interrupt()
        }
    }
}
