package br.com.nexusrmm.agent

import android.app.*
import android.content.Context
import android.content.Intent
import android.os.*
import android.util.Log
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.engineio.client.transports.WebSocket
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.KeyFactory
import java.security.KeyStore
import java.security.cert.CertificateFactory
import java.security.spec.PKCS8EncodedKeySpec
import java.util.concurrent.TimeUnit
import javax.net.ssl.*

/**
 * Serviço principal do agente Nexus RMM.
 * Mantém conexão Socket.io mTLS com o servidor e gerencia:
 * - Presença (heartbeat a cada 20s)
 * - Inventário (ao conectar)
 * - Métricas CPU/RAM (a cada 20s)
 * - Terminal Shell remoto
 * - Tela remota (delega ao ScreenCaptureService)
 */
class AgentService : Service() {
    companion object {
        const val TAG = "AgentService"
        const val CHANNEL_ID = "nexus_agent_main"
        const val NOTIF_ID = 1

        @Volatile var instance: AgentService? = null
    }

    private var socket: Socket? = null

    /** Expõe o estado da conexão sem vazar a referência interna do socket. */
    val isSocketConnected: Boolean get() = socket?.connected() == true

    private var heartbeatHandler: Handler? = null
    private var heartbeatRunnable: Runnable? = null
    private val startTime = System.currentTimeMillis()
    private val activeShells = mutableMapOf<String, java.lang.Process>()
    // Última localização enviada ao servidor — evita enviar o mesmo ponto repetidamente
    @Volatile private var lastSentLocationTime = 0L

    // MediaProjection grant: armazenado após usuário aprovar na MainActivity
    var projectionResultCode = Activity.RESULT_CANCELED
    var projectionData: Intent? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        createChannel()
        startForeground(NOTIF_ID, buildNotif("Iniciando…"))
        connectSocket()
    }

    // ─── Socket.io mTLS ──────────────────────────────────────────────────────

    private fun connectSocket() {
        val machineId  = AgentConfig.machineId(this)
        val gatewayUrl = AgentConfig.gatewayUrl(this)
        if (machineId.isEmpty() || gatewayUrl.isEmpty()) {
            Log.w(TAG, "Not enrolled — skipping socket connect")
            updateNotif("Aguardando cadastro…")
            return
        }

        try {
            val okHttp = buildMtlsClient()
            val opts = IO.Options().apply {
                transports       = arrayOf(WebSocket.NAME)
                secure           = true
                reconnection     = true
                reconnectionAttempts = Int.MAX_VALUE
                reconnectionDelay    = 5_000
                callFactory      = okHttp
                webSocketFactory = okHttp
            }

            val sock = IO.socket("$gatewayUrl/agent", opts)
            socket = sock

            sock.on(Socket.EVENT_CONNECT) {
                if (BuildConfig.DEBUG) Log.d(TAG, "Connected to server")
                updateNotif("Conectado")
                sendInventory()
                startHeartbeat()
                // Inicia localização (econômica) após conectar
                NexusLocationManager.start(this@AgentService)
            }
            sock.on(Socket.EVENT_DISCONNECT) {
                if (BuildConfig.DEBUG) Log.d(TAG, "Disconnected")
                updateNotif("Reconectando…")
                stopHeartbeat()
            }
            sock.on(Socket.EVENT_CONNECT_ERROR) { args ->
                if (BuildConfig.DEBUG) Log.e(TAG, "Connect error: ${args.firstOrNull()}")
            }

            // ── Terminal ──
            sock.on("server:terminal-start") { args ->
                val cfg       = args.firstOrNull() as? JSONObject ?: return@on
                val sessionId = cfg.optString("sessionId")
                if (sessionId.isNotEmpty()) startShell(sessionId)
            }
            sock.on("server:terminal-stdin") { args ->
                val pl        = args.firstOrNull() as? JSONObject ?: return@on
                val sessionId = pl.optString("sessionId")
                val data      = pl.optString("data")
                activeShells[sessionId]?.outputStream?.let {
                    runCatching { it.write(data.toByteArray()); it.flush() }
                }
            }
            sock.on("server:terminal-stop") { args ->
                val pl = args.firstOrNull() as? JSONObject ?: return@on
                stopShell(pl.optString("sessionId"))
            }

            // ── Tela remota ──
            sock.on("server:screen-start") { args ->
                val cfg = args.firstOrNull() as? JSONObject ?: return@on
                handleScreenStart(cfg)
            }
            sock.on("server:get-monitors") { _ ->
                val monitores = JSONArray().apply {
                    put(JSONObject().apply {
                        put("idx", 0)
                        put("w", resources.displayMetrics.widthPixels)
                        put("h", resources.displayMetrics.heightPixels)
                        put("x", 0); put("y", 0)
                    })
                }
                sock.emit("agent:monitors", JSONObject().apply {
                    put("machineId", machineId)
                    put("monitores", monitores)
                })
            }

            // ── Update disponível ──
            sock.on("server:update-available") { args ->
                val pl      = args.firstOrNull() as? JSONObject ?: return@on
                val version = pl.optString("version")
                showUpdateNotif(version)
            }

            sock.connect()
        } catch (e: Exception) {
            Log.e(TAG, "Socket setup failed", e)
        }
    }

    // ─── Heartbeat + métricas ─────────────────────────────────────────────────

    private fun startHeartbeat() {
        stopHeartbeat()
        val h = Handler(Looper.getMainLooper())
        val r = object : Runnable {
            override fun run() {
                sendHeartbeat()
                sendMetrics()
                h.postDelayed(this, 20_000)
            }
        }
        h.post(r)
        heartbeatHandler = h
        heartbeatRunnable = r
    }

    private fun stopHeartbeat() {
        heartbeatRunnable?.let { heartbeatHandler?.removeCallbacks(it) }
        heartbeatHandler = null; heartbeatRunnable = null
    }

    private fun sendHeartbeat() {
        val uptimeSec = (System.currentTimeMillis() - startTime) / 1000
        socket?.emit("agent:heartbeat", JSONObject().apply {
            put("machineId",      AgentConfig.machineId(this@AgentService))
            put("versaoAgente",   EnrollManager.AGENT_VERSION)
            put("uptimeSegundos", uptimeSec)
            put("enviadoEm",      System.currentTimeMillis())
        })
        // Envia localização somente quando ela mudou desde o último envio
        val loc = NexusLocationManager.getLastLocation() ?: return
        if (loc.time > lastSentLocationTime) {
            lastSentLocationTime = loc.time
            NexusLocationManager.toJson()?.also { locJson ->
                locJson.put("machineId", AgentConfig.machineId(this@AgentService))
                socket?.emit("agent:location", locJson)
            }
        }
    }

    private fun sendInventory() = Thread {
        runCatching {
            socket?.emit("agent:inventory", InventoryManager.collect(this))
        }
    }.start()

    private fun sendMetrics() = runCatching {
        socket?.emit("agent:metrics", InventoryManager.metricas(this))
    }

    // ─── Terminal Shell ───────────────────────────────────────────────────────

    private fun startShell(sessionId: String) {
        if (activeShells.containsKey(sessionId)) return
        Thread {
            runCatching {
                val proc = ProcessBuilder("/system/bin/sh")
                    .redirectErrorStream(true)
                    .start()
                activeShells[sessionId] = proc

                // Lê stdout do shell e envia ao painel
                Thread {
                    val buf = ByteArray(4096)
                    runCatching {
                        while (proc.isAlive) {
                            val n = proc.inputStream.read(buf)
                            if (n <= 0) break
                            socket?.emit("agent:terminal-stdout", JSONObject().apply {
                                put("sessionId", sessionId)
                                put("data", String(buf, 0, n, Charsets.UTF_8))
                            })
                        }
                    }
                    activeShells.remove(sessionId)
                    socket?.emit("agent:terminal-exit", JSONObject().apply {
                        put("sessionId", sessionId); put("code", 0)
                    })
                }.start()
            }.onFailure {
                Log.e(TAG, "Shell start error", it)
                activeShells.remove(sessionId)
                socket?.emit("agent:terminal-exit", JSONObject().apply {
                    put("sessionId", sessionId); put("code", 1)
                })
            }
        }.start()
    }

    private fun stopShell(sessionId: String) {
        activeShells.remove(sessionId)?.destroy()
    }

    // ─── Tela remota ──────────────────────────────────────────────────────────

    private fun handleScreenStart(cfg: JSONObject) {
        if (projectionResultCode == Activity.RESULT_OK && projectionData != null) {
            launchScreenCapture(cfg)
        } else {
            // Precisa de permissão — abre MainActivity para o usuário aprovar
            val intent = Intent(this, MainActivity::class.java).apply {
                action = MainActivity.ACTION_REQUEST_SCREEN
                putExtra(MainActivity.EXTRA_SCREEN_CFG, cfg.toString())
                flags  = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            }
            startActivity(intent)
        }
    }

    fun launchScreenCapture(cfg: JSONObject) {
        // Para qualquer captura anterior
        ScreenCaptureService.instance?.stopSelf()

        val intent = Intent(this, ScreenCaptureService::class.java).apply {
            putExtra(ScreenCaptureService.EXTRA_RESULT_CODE,  projectionResultCode)
            putExtra(ScreenCaptureService.EXTRA_RESULT_DATA,  projectionData)
            putExtra(ScreenCaptureService.EXTRA_RELAY_URL,    cfg.optString("relayUrl"))
            putExtra(ScreenCaptureService.EXTRA_AGENT_TOKEN,  cfg.optString("agentToken"))
            putExtra(ScreenCaptureService.EXTRA_MACHINE_ID,   cfg.optString("machineId", AgentConfig.machineId(this@AgentService)))
            putExtra(ScreenCaptureService.EXTRA_HOSTNAME,     Build.MODEL)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            startForegroundService(intent)
        else
            startService(intent)
    }

    // ─── mTLS OkHttp ─────────────────────────────────────────────────────────

    private fun buildMtlsClient(): OkHttpClient {
        return try {
            val caCertPem = AgentConfig.caCertPem(this)
            val clientPem = AgentConfig.clientCertPem(this)
            val privBytes = AgentConfig.privateKeyBytes(this)

            if (caCertPem.isEmpty() || clientPem.isEmpty() || privBytes == null) {
                return OkHttpClient.Builder()
                    .connectTimeout(10, TimeUnit.SECONDS)
                    .readTimeout(0, TimeUnit.SECONDS)
                    .build()
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

            val ssl = SSLContext.getInstance("TLS").also {
                it.init(kmf.keyManagers, tmf.trustManagers, null)
            }

            OkHttpClient.Builder()
                .sslSocketFactory(ssl.socketFactory, tmf.trustManagers[0] as X509TrustManager)
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .build()
        } catch (e: Exception) {
            Log.e(TAG, "mTLS setup failed", e)
            OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.SECONDS)
                .build()
        }
    }

    private fun parseCert(pem: String): java.security.cert.Certificate {
        val b64 = pem.replace("-----BEGIN CERTIFICATE-----", "")
            .replace("-----END CERTIFICATE-----", "")
            .replace("\n", "").replace("\r", "").trim()
        val bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT)
        return CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(bytes))
    }

    // ─── Notifications ────────────────────────────────────────────────────────

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(
                    NotificationChannel(CHANNEL_ID, "Nexus RMM Agent",
                        NotificationManager.IMPORTANCE_LOW)
                        .apply { description = "Agente de monitoramento remoto" }
                )
        }
    }

    private fun buildNotif(text: String): Notification {
        val pi = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Nexus RMM Agente")
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(true).build()
        else @Suppress("DEPRECATION")
            Notification.Builder(this)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentTitle("Nexus RMM Agente")
                .setContentText(text)
                .setContentIntent(pi)
                .setOngoing(true).build()
    }

    private fun updateNotif(text: String) {
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIF_ID, buildNotif(text))
    }

    private fun showUpdateNotif(version: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).let { nm ->
                if (nm.getNotificationChannel("nexus_update") == null)
                    nm.createNotificationChannel(
                        NotificationChannel("nexus_update", "Atualizações",
                            NotificationManager.IMPORTANCE_DEFAULT)
                    )
                nm.notify(2, Notification.Builder(this, "nexus_update")
                    .setSmallIcon(android.R.drawable.stat_sys_download)
                    .setContentTitle("Nexus RMM — Atualização disponível")
                    .setContentText("v$version disponível. Baixe o novo APK no painel.")
                    .setAutoCancel(true).build())
            }
        }
    }

    override fun onBind(intent: Intent?) = null

    override fun onDestroy() {
        super.onDestroy()
        stopHeartbeat()
        NexusLocationManager.stop()
        socket?.disconnect()
        activeShells.values.forEach { runCatching { it.destroy() } }
        activeShells.clear()
        if (instance === this) instance = null
    }
}
