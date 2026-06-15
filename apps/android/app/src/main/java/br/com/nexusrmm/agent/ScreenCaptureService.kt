package br.com.nexusrmm.agent

import android.app.*
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.*
import android.util.Log
import okhttp3.*
import okio.ByteString.Companion.toByteString
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.concurrent.TimeUnit
import javax.net.ssl.*

/**
 * Foreground Service de captura de tela.
 * Declarado com foregroundServiceType="mediaProjection" para cumprir exigência do Android 10+.
 * Conecta ao relay WebSocket e transmite frames JPEG no protocolo [0x01][w4][h4][JPEG].
 */
class ScreenCaptureService : Service() {
    companion object {
        const val TAG = "ScreenCaptureService"
        const val CHANNEL_ID = "nexus_screen"
        const val NOTIF_ID = 3

        const val EXTRA_RESULT_CODE  = "result_code"
        const val EXTRA_RESULT_DATA  = "result_data"
        const val EXTRA_RELAY_URL    = "relay_url"
        const val EXTRA_AGENT_TOKEN  = "agent_token"
        const val EXTRA_MACHINE_ID   = "machine_id"
        const val EXTRA_HOSTNAME     = "hostname"

        @Volatile var instance: ScreenCaptureService? = null
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var captureThread: HandlerThread? = null
    private var captureHandler: Handler? = null
    private var wsClient: OkHttpClient? = null
    private var ws: WebSocket? = null
    private var viewerConnected = false
    private var quality = 65
    private var fps = 10
    private var lastHash = 0
    private var screenW = 0
    private var screenH = 0
    private var screenDpi = 0

    override fun onCreate() {
        super.onCreate()
        instance = this
        screenW   = resources.displayMetrics.widthPixels
        screenH   = resources.displayMetrics.heightPixels
        screenDpi = resources.displayMetrics.densityDpi
        createChannel()
        startForeground(NOTIF_ID, buildNotif("Iniciando captura…"))
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
            ?: Activity.RESULT_CANCELED
        val resultData = intent?.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
        val relayUrl   = intent?.getStringExtra(EXTRA_RELAY_URL) ?: ""
        val agentToken = intent?.getStringExtra(EXTRA_AGENT_TOKEN) ?: ""
        val machineId  = intent?.getStringExtra(EXTRA_MACHINE_ID) ?: AgentConfig.machineId(this)
        val hostname   = intent?.getStringExtra(EXTRA_HOSTNAME) ?: Build.MODEL

        if (resultCode == Activity.RESULT_OK && resultData != null) {
            val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            mediaProjection = mgr.getMediaProjection(resultCode, resultData)
            connectRelay(relayUrl, agentToken, machineId, hostname)
        } else {
            Log.e(TAG, "MediaProjection permission denied or missing")
            stopSelf()
        }

        return START_NOT_STICKY
    }

    // ─── Relay WebSocket ─────────────────────────────────────────────────────

    private fun connectRelay(relayUrl: String, agentToken: String, machineId: String, hostname: String) {
        wsClient = buildOkHttp()
        val url = "$relayUrl?token=${agentToken}&machineId=${machineId}&hostname=${hostname}"
        Log.d(TAG, "Connecting relay: $url")

        val req = Request.Builder().url(url).build()
        ws = wsClient!!.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                Log.d(TAG, "Relay connected")
                updateNotif("Aguardando viewer…")
            }

            override fun onMessage(ws: WebSocket, text: String) {
                try {
                    val json = JSONObject(text)
                    when (json.optString("type")) {
                        "open"  -> { viewerConnected = true;  startCapture(); updateNotif("Transmitindo tela") }
                        "close" -> { viewerConnected = false; stopCapture();  updateNotif("Viewer desconectou") }
                    }
                    val cmd = json.optString("cmd")
                    if (cmd.isNotEmpty()) {
                        when (cmd) {
                            "qualidade" -> quality = json.optInt("q", 65)
                            "fps"       -> fps     = json.optInt("v", 10)
                            else        -> InputAccessibilityService.instance?.handleCommand(json)
                        }
                    }
                } catch (_: Exception) {}
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "Relay closed: $code")
                stopCapture()
                stopSelf()
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                Log.e(TAG, "Relay error", t)
                stopCapture()
                stopSelf()
            }
        })
    }

    // ─── Screen capture loop ──────────────────────────────────────────────────

    private fun startCapture() {
        if (virtualDisplay != null) return
        captureThread = HandlerThread("NexusCapture").also { it.start() }
        captureHandler = Handler(captureThread!!.looper)

        imageReader = ImageReader.newInstance(screenW, screenH, PixelFormat.RGBA_8888, 2)
        virtualDisplay = mediaProjection?.createVirtualDisplay(
            "NexusScreen", screenW, screenH, screenDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader!!.surface, null, captureHandler
        )
        scheduleCapture()
    }

    private fun scheduleCapture() {
        if (captureHandler == null) return
        val intervalMs = (1000 / fps.coerceIn(5, 30)).toLong()
        captureHandler!!.postDelayed(object : Runnable {
            override fun run() {
                if (viewerConnected && ws != null) {
                    captureAndSend()
                    captureHandler?.postDelayed(this, intervalMs)
                }
            }
        }, intervalMs)
    }

    private fun captureAndSend() {
        val reader = imageReader ?: return
        val image  = reader.acquireLatestImage() ?: return
        try {
            val plane  = image.planes[0]
            val buffer = plane.buffer
            val rowPad = plane.rowStride - plane.pixelStride * screenW

            val bmp = Bitmap.createBitmap(
                screenW + rowPad / plane.pixelStride,
                screenH, Bitmap.Config.ARGB_8888
            )
            bmp.copyPixelsFromBuffer(buffer)
            val cropped = Bitmap.createBitmap(bmp, 0, 0, screenW, screenH)
            bmp.recycle()

            val out = ByteArrayOutputStream()
            cropped.compress(Bitmap.CompressFormat.JPEG, quality, out)
            cropped.recycle()

            val jpeg = out.toByteArray()
            val hash = jpeg.take(256).hashCode()
            if (hash == lastHash) return
            lastHash = hash

            // Frame: [0x01][w 4B LE][h 4B LE][JPEG bytes]
            val frame = ByteBuffer.allocate(9 + jpeg.size).order(ByteOrder.LITTLE_ENDIAN)
            frame.put(0x01.toByte())
            frame.putInt(screenW)
            frame.putInt(screenH)
            frame.put(jpeg)
            ws?.send(frame.array().toByteString())
        } catch (e: Exception) {
            Log.e(TAG, "Capture error", e)
        } finally {
            image.close()
        }
    }

    private fun stopCapture() {
        captureHandler?.removeCallbacksAndMessages(null)
        virtualDisplay?.release(); virtualDisplay = null
        imageReader?.close();      imageReader = null
        captureThread?.quitSafely(); captureThread = null
        captureHandler = null
    }

    // ─── mTLS OkHttp ─────────────────────────────────────────────────────────

    private fun buildOkHttp(): OkHttpClient {
        return try {
            val caCertPem  = AgentConfig.caCertPem(this)
            val clientPem  = AgentConfig.clientCertPem(this)
            val privBytes  = AgentConfig.privateKeyBytes(this)

            if (caCertPem.isEmpty() || clientPem.isEmpty() || privBytes == null) {
                return fallbackClient()
            }

            val caCert = parseCert(caCertPem)
            val ts = KeyStore.getInstance(KeyStore.getDefaultType()).also {
                it.load(null, null); it.setCertificateEntry("ca", caCert)
            }
            val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm())
                .also { it.init(ts) }

            val clientCert = parseCert(clientPem)
            val privKey    = KeyFactory.getInstance("RSA")
                .generatePrivate(PKCS8EncodedKeySpec(privBytes))
            val ks = KeyStore.getInstance(KeyStore.getDefaultType()).also {
                it.load(null, null); it.setKeyEntry("c", privKey, null, arrayOf(clientCert))
            }
            val kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm())
                .also { it.init(ks, null) }

            val ssl = SSLContext.getInstance("TLS")
                .also { it.init(kmf.keyManagers, tmf.trustManagers, null) }

            OkHttpClient.Builder()
                .sslSocketFactory(ssl.socketFactory, tmf.trustManagers[0] as X509TrustManager)
                .pingInterval(20, TimeUnit.SECONDS)
                .build()
        } catch (e: Exception) {
            Log.e(TAG, "mTLS setup failed, using trust-all", e)
            fallbackClient()
        }
    }

    private fun fallbackClient(): OkHttpClient {
        val tm = object : X509TrustManager {
            override fun checkClientTrusted(c: Array<java.security.cert.X509Certificate>, a: String) {}
            override fun checkServerTrusted(c: Array<java.security.cert.X509Certificate>, a: String) {}
            override fun getAcceptedIssuers() = emptyArray<java.security.cert.X509Certificate>()
        }
        val ssl = SSLContext.getInstance("TLS").also { it.init(null, arrayOf(tm), null) }
        return OkHttpClient.Builder()
            .hostnameVerifier { _, _ -> true }
            .sslSocketFactory(ssl.socketFactory, tm)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }

    private fun parseCert(pem: String): java.security.cert.Certificate {
        val b64   = pem.replace("-----BEGIN CERTIFICATE-----", "")
            .replace("-----END CERTIFICATE-----", "")
            .replace("\n", "").replace("\r", "").trim()
        val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
        return CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(bytes))
    }

    // ─── Foreground notification ──────────────────────────────────────────────

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Nexus Tela Remota",
                        NotificationManager.IMPORTANCE_LOW)
                )
        }
    }

    private fun buildNotif(text: String) =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setContentTitle("Nexus RMM — Tela remota")
                .setContentText(text)
                .setOngoing(true).build()
        else @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_menu_camera)
                .setContentTitle("Nexus RMM — Tela remota")
                .setContentText(text)
                .setOngoing(true).build()

    private fun updateNotif(text: String) {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIF_ID, buildNotif(text))
    }

    override fun onBind(intent: Intent?) = null

    override fun onDestroy() {
        super.onDestroy()
        stopCapture()
        ws?.close(1000, "Service stopped")
        wsClient?.dispatcher?.executorService?.shutdown()
        mediaProjection?.stop()
        if (instance === this) instance = null
    }
}
