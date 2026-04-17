package dev.uitreeserver

import android.graphics.Bitmap
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.Configurator
import androidx.test.uiautomator.UiDevice
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import java.security.MessageDigest
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch

/**
 * Android instrumentation test that runs an HTTP server on the device.
 * Entry point: startServer()
 *
 * Spawned via:
 *   adb shell am instrument -w -r -e class dev.uitreeserver.UITreeServer#startServer
 *     -e port {port} dev.uitreeserver.test/androidx.test.runner.AndroidJUnitRunner
 */
class UITreeServer {

    private val gson: Gson = GsonBuilder().serializeNulls().create()

    @Test
    fun startServer() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val arguments = InstrumentationRegistry.getArguments()
        val port = arguments.getString("port", "8080").toInt()

        // Read auth token from device file (written by MCP bootstrap to avoid process arg exposure)
        val tokenFile = java.io.File("/data/local/tmp/.mds_auth_$port")
        val authToken = if (tokenFile.exists()) {
            val token = tokenFile.readText().trim()
            tokenFile.delete()
            token
        } else {
            ""
        }

        // Configure UIAutomator with minimal timeouts
        val configurator = Configurator.getInstance()
        configurator.waitForIdleTimeout = 0
        configurator.waitForSelectorTimeout = 0
        configurator.actionAcknowledgmentTimeout = 0

        val device = UiDevice.getInstance(instrumentation)
        val coord = Coord.compute(device.displayWidth, device.displayHeight)
        android.util.Log.i(
            "UITreeServer",
            "renderScale=${coord.renderScale} native=${device.displayWidth}x${device.displayHeight} target=${Coord.TARGET_LONG_EDGE}"
        )
        val extractor = UITreeExtractor(device)
        val interactions = Interactions(device, instrumentation)
        val cdpClient = CdpClient()
        val webViewExtractor = WebViewExtractor(cdpClient)
        val jsEngine = JsEngine(device, coord)

        val server = embeddedServer(CIO, port = port, host = "127.0.0.1") {
            // Security: reject requests with non-localhost Host header (DNS rebinding defense)
            // and validate auth token on all routes except /health
            intercept(io.ktor.server.application.ApplicationCallPipeline.Plugins) {
                val host = call.request.headers["Host"]
                if (host == null || !host.matches(Regex("^(localhost|127\\.0\\.0\\.1)(:\\d+)?$"))) {
                    call.respond(HttpStatusCode.Forbidden, "Forbidden")
                    finish()
                    return@intercept
                }
                if (call.request.uri != "/health") {
                    if (authToken.isEmpty()) {
                        call.respond(HttpStatusCode.Unauthorized, "Server misconfigured: no auth token")
                        finish()
                        return@intercept
                    }
                    val header = call.request.headers["Authorization"] ?: ""
                    val expected = "Bearer $authToken".toByteArray()
                    val received = header.toByteArray()
                    if (!MessageDigest.isEqual(expected, received)) {
                        call.respond(HttpStatusCode.Unauthorized, "Unauthorized")
                        finish()
                        return@intercept
                    }
                }
            }

            routing {
                // GET /health
                get("/health") {
                    call.respondText("OK")
                }

                // GET /uitree
                get("/uitree") {
                    val includeWebview = call.request.queryParameters["webview"]?.toBoolean() ?: true

                    val treeResponse = extractor.extract()
                    var nodes = treeResponse.nodes

                    // WebView augmentation
                    if (includeWebview) {
                        try {
                            val containers = UITreeUtils.findWebViewContainers(nodes)
                            if (containers.isNotEmpty()) {
                                val webviewChildren = webViewExtractor.extractWebViewNodes(
                                    containers, nodes,
                                    treeResponse.screenWidth, treeResponse.screenHeight
                                )
                                if (webviewChildren.isNotEmpty()) {
                                    nodes = UITreeUtils.augmentTreeWithWebViewNodes(nodes, webviewChildren)
                                }
                            }
                        } catch (e: Exception) {
                            android.util.Log.e("UITreeServer", "WebView augmentation failed: ${e.message}", e)
                        }
                    }

                    // Scale to render space (single seam: Coord)
                    val scaledNodes = coord.scaleNodes(nodes)
                    val scaledW = coord.toRenderInt(treeResponse.screenWidth)
                    val scaledH = coord.toRenderInt(treeResponse.screenHeight)

                    val response = JsonObject().apply {
                        addProperty("rotation", treeResponse.rotation)
                        addProperty("screenWidth", scaledW)
                        addProperty("screenHeight", scaledH)
                        add("nodes", UITreeSerializer.serializeNodes(scaledNodes))
                    }

                    call.respondText(gson.toJson(response), ContentType.Application.Json)
                }


                // GET /screenshot — pixel dims match render space exactly.
                get("/screenshot") {
                    val bitmap = instrumentation.uiAutomation.takeScreenshot()
                    if (bitmap == null) {
                        call.respond(HttpStatusCode.InternalServerError, "Failed to take screenshot")
                        return@get
                    }
                    // Render-space dims come from display (not bitmap) so a screenshot pixel
                    // at (x, y) corresponds to the same screen location as a hierarchy bound at (x, y).
                    val renderW = coord.toRenderInt(device.displayWidth)
                    val renderH = coord.toRenderInt(device.displayHeight)
                    val output = if (renderW == bitmap.width && renderH == bitmap.height) {
                        bitmap
                    } else {
                        val scaled = Bitmap.createScaledBitmap(bitmap, renderW, renderH, true)
                        bitmap.recycle()
                        scaled
                    }
                    val stream = ByteArrayOutputStream()
                    output.compress(Bitmap.CompressFormat.JPEG, 75, stream)
                    output.recycle()
                    call.respondBytes(stream.toByteArray(), ContentType.Image.JPEG)
                }

                // POST /tap — render coords in, native dispatched via Coord.
                post("/tap") {
                    val x = call.request.queryParameters["x"]?.toFloatOrNull()
                    val y = call.request.queryParameters["y"]?.toFloatOrNull()
                    if (x == null || y == null) {
                        call.respond(HttpStatusCode.BadRequest, "Missing required parameters: x, y")
                        return@post
                    }
                    val success = interactions.tap(coord.toNativeInt(x), coord.toNativeInt(y))
                    if (success) {
                        call.respondText("OK")
                    } else {
                        call.respond(HttpStatusCode.InternalServerError, "Tap failed")
                    }
                }

                // POST /doubleTap
                post("/doubleTap") {
                    val x = call.request.queryParameters["x"]?.toFloatOrNull()
                    val y = call.request.queryParameters["y"]?.toFloatOrNull()
                    if (x == null || y == null) {
                        call.respond(HttpStatusCode.BadRequest, "Missing required parameters: x, y")
                        return@post
                    }
                    interactions.doubleTap(coord.toNativeInt(x), coord.toNativeInt(y))
                    call.respondText("OK")
                }

                // POST /longPress
                post("/longPress") {
                    val x = call.request.queryParameters["x"]?.toFloatOrNull()
                    val y = call.request.queryParameters["y"]?.toFloatOrNull()
                    if (x == null || y == null) {
                        call.respond(HttpStatusCode.BadRequest, "Missing required parameters: x, y")
                        return@post
                    }
                    val duration = call.request.queryParameters["duration"]?.toIntOrNull() ?: 500
                    interactions.longPress(coord.toNativeInt(x), coord.toNativeInt(y), duration)
                    call.respondText("OK")
                }

                // POST /scroll
                post("/scroll") {
                    val startX = call.request.queryParameters["startX"]?.toFloatOrNull()
                    val startY = call.request.queryParameters["startY"]?.toFloatOrNull()
                    val endX = call.request.queryParameters["endX"]?.toFloatOrNull()
                    val endY = call.request.queryParameters["endY"]?.toFloatOrNull()
                    if (startX == null || startY == null || endX == null || endY == null) {
                        call.respond(HttpStatusCode.BadRequest, "Missing required parameters: startX, startY, endX, endY")
                        return@post
                    }
                    interactions.scroll(
                        coord.toNativeInt(startX),
                        coord.toNativeInt(startY),
                        coord.toNativeInt(endX),
                        coord.toNativeInt(endY)
                    )
                    call.respondText("OK")
                }

                // POST /type
                post("/type") {
                    val text = call.request.queryParameters["text"]
                    if (text.isNullOrEmpty()) {
                        call.respond(HttpStatusCode.BadRequest, "Missing required parameter: text")
                        return@post
                    }
                    val success = interactions.type(text)
                    if (success) {
                        call.respondText("OK")
                    } else {
                        call.respond(HttpStatusCode.BadRequest, "No focused element found")
                    }
                }

                // POST /press
                post("/press") {
                    val button = call.request.queryParameters["button"]
                    if (button.isNullOrEmpty()) {
                        call.respond(HttpStatusCode.BadRequest, "Missing required parameter: button")
                        return@post
                    }
                    val (success, error) = interactions.press(button)
                    if (error != null) {
                        call.respond(HttpStatusCode.BadRequest, error)
                    } else if (success) {
                        call.respondText("OK")
                    } else {
                        call.respond(HttpStatusCode.InternalServerError, "Press failed")
                    }
                }

                // POST /launchApp
                post("/launchApp") {
                    val packageName = call.request.queryParameters["packageName"]
                    if (packageName.isNullOrEmpty()) {
                        call.respond(HttpStatusCode.BadRequest, "Missing required parameter: packageName")
                        return@post
                    }
                    val (success, error) = interactions.launchApp(packageName)
                    if (success) {
                        call.respondText("OK")
                    } else {
                        call.respond(HttpStatusCode.NotFound, error ?: "App not found")
                    }
                }

                // POST /terminateApp
                post("/terminateApp") {
                    val packageName = call.request.queryParameters["packageName"]
                    if (packageName.isNullOrEmpty()) {
                        call.respond(HttpStatusCode.BadRequest, "Missing required parameter: packageName")
                        return@post
                    }
                    val (success, error) = interactions.terminateApp(packageName)
                    if (success) {
                        call.respondText("OK")
                    } else {
                        call.respond(HttpStatusCode.BadRequest, error ?: "Failed to terminate app")
                    }
                }

                // GET /listApps
                get("/listApps") {
                    val apps = interactions.listApps()
                    call.respondText(gson.toJson(apps), ContentType.Application.Json)
                }

                // POST /exec
                post("/exec") {
                    val code = call.receiveText()
                    if (code.isBlank()) {
                        call.respond(HttpStatusCode.BadRequest, "Empty code")
                        return@post
                    }
                    try {
                        val result = jsEngine.execute(code)
                        val response = JsonObject().apply {
                            addProperty("result", result.result)
                            add("logs", gson.toJsonTree(result.logs))
                        }
                        call.respondText(gson.toJson(response), ContentType.Application.Json)
                    } catch (e: Exception) {
                        call.respond(HttpStatusCode.BadRequest, "JavaScript execution error")
                    }
                }
            }
        }

        server.start(wait = false)

        // Block the test thread indefinitely so the server stays alive
        val latch = CountDownLatch(1)
        latch.await()
    }
}
