package br.com.nexusrmm.agent

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.launch

class MainActivity : AppCompatActivity() {
    companion object {
        const val ACTION_REQUEST_SCREEN = "br.com.nexusrmm.agent.REQUEST_SCREEN"
        const val EXTRA_SCREEN_CFG      = "screen_cfg"
    }

    // UI
    private lateinit var tvStatus:    TextView
    private lateinit var tvMachineId: TextView
    private lateinit var tvAccess:    TextView
    private lateinit var tvScreen:    TextView
    private lateinit var tvLocation:  TextView
    private lateinit var etServer:    TextInputEditText
    private lateinit var etToken:     TextInputEditText
    private lateinit var layoutEnroll: View
    private lateinit var layoutPerms:  View
    private lateinit var layoutActions:View
    private lateinit var btnEnroll:    MaterialButton
    private lateinit var btnAccess:    MaterialButton
    private lateinit var btnScreen:    MaterialButton
    private lateinit var btnLocation:  MaterialButton
    private lateinit var btnReenroll:  MaterialButton

    // Pending screen cfg (when MediaProjection result comes in)
    private var pendingScreenCfgJson: String? = null

    // Location permission launcher (runtime — Android 6+)
    private val locationPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { grants ->
        val coarseOk = grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
        val fineOk   = grants[Manifest.permission.ACCESS_FINE_LOCATION]   == true
        if (coarseOk || fineOk) {
            Toast.makeText(this, "Localização autorizada ✓", Toast.LENGTH_SHORT).show()
            // Reinicia o LocationManager com a permissão recém-concedida
            AgentService.instance?.let { NexusLocationManager.start(it) }
        } else {
            Toast.makeText(this, "Localização negada — rastreamento desativado.", Toast.LENGTH_LONG).show()
        }
        refreshUi()
    }

    // MediaProjection permission launcher
    private val screenPermLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK && result.data != null) {
            val svc = AgentService.instance
            if (svc != null) {
                svc.projectionResultCode = result.resultCode
                svc.projectionData       = result.data
                // Se havia uma cfg pendente, inicia a captura
                pendingScreenCfgJson?.let { json ->
                    svc.launchScreenCapture(org.json.JSONObject(json))
                    pendingScreenCfgJson = null
                }
            }
            tvScreen.text    = "● Captura de tela — Autorizada ✓"
            tvScreen.setTextColor(0xFF00C070.toInt())
        } else {
            Toast.makeText(this, "Permissão de tela negada.", Toast.LENGTH_SHORT).show()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        bindViews()
        setupListeners()
        refreshUi()
        handleIncomingIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        refreshUi()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent?.action == ACTION_REQUEST_SCREEN) {
            pendingScreenCfgJson = intent.getStringExtra(EXTRA_SCREEN_CFG)
            requestScreenPermission()
        }
    }

    // ─── UI Binding ──────────────────────────────────────────────────────────

    private fun bindViews() {
        tvStatus     = findViewById(R.id.tvStatus)
        tvMachineId  = findViewById(R.id.tvMachineId)
        tvAccess     = findViewById(R.id.tvAccessStatus)
        tvScreen     = findViewById(R.id.tvScreenStatus)
        tvLocation   = findViewById(R.id.tvLocationStatus)
        etServer     = findViewById(R.id.etServerUrl)
        etToken      = findViewById(R.id.etToken)
        layoutEnroll = findViewById(R.id.layoutEnroll)
        layoutPerms  = findViewById(R.id.layoutPermissions)
        layoutActions= findViewById(R.id.layoutActions)
        btnEnroll    = findViewById(R.id.btnEnroll)
        btnAccess    = findViewById(R.id.btnAccessibility)
        btnScreen    = findViewById(R.id.btnScreenPerm)
        btnLocation  = findViewById(R.id.btnLocationPerm)
        btnReenroll  = findViewById(R.id.btnReenroll)
    }

    private fun setupListeners() {
        btnEnroll.setOnClickListener { doEnroll() }

        btnAccess.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }

        btnScreen.setOnClickListener { requestScreenPermission() }

        btnLocation.setOnClickListener { requestLocationPermission() }

        btnReenroll.setOnClickListener {
            AgentConfig.clear(this)
            AgentService.instance?.stopSelf()
            refreshUi()
        }
    }

    // ─── Enrollment ──────────────────────────────────────────────────────────

    private fun doEnroll() {
        val server = etServer.text?.toString()?.trim() ?: ""
        val token  = etToken.text?.toString()?.trim()  ?: ""

        if (server.isEmpty() || token.isEmpty()) {
            Toast.makeText(this, "Preencha URL e token.", Toast.LENGTH_SHORT).show()
            return
        }

        btnEnroll.isEnabled = false
        tvStatus.text = "Cadastrando…"

        lifecycleScope.launch {
            val result = EnrollManager.enroll(this@MainActivity, server, token)
            result.fold(
                onSuccess = { r ->
                    // Persiste as credenciais
                    AgentConfig.save(
                        ctx           = this@MainActivity,
                        machineId     = r.machineId,
                        serverUrl     = server,
                        gatewayUrl    = AgentConfig.gatewayFromServer(server),
                        hostname      = r.hostname,
                        clientCertPem = r.clientCertPem,
                        caCertPem     = r.caCertPem,
                        privateKeyBytes = r.privateKey.encoded,
                    )
                    // Inicia o serviço
                    startAgentService()
                    refreshUi()
                    Toast.makeText(this@MainActivity,
                        "Cadastrado com sucesso!", Toast.LENGTH_LONG).show()
                },
                onFailure = { e ->
                    tvStatus.text = "Erro: ${e.message}"
                    Toast.makeText(this@MainActivity,
                        "Falha: ${e.message}", Toast.LENGTH_LONG).show()
                }
            )
            btnEnroll.isEnabled = true
        }
    }

    private fun startAgentService() {
        val intent = Intent(this, AgentService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            startForegroundService(intent)
        else
            startService(intent)
    }

    // ─── Screen permission ───────────────────────────────────────────────────

    private fun requestScreenPermission() {
        val mgr = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        screenPermLauncher.launch(mgr.createScreenCaptureIntent())
    }

    // ─── Location permission ─────────────────────────────────────────────────

    private fun requestLocationPermission() {
        val perms = mutableListOf(
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.ACCESS_FINE_LOCATION,
        )
        // Background location: Android 10+ — pedido separado após conceder foreground
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            perms.add(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        }
        locationPermLauncher.launch(perms.toTypedArray())
    }

    private fun isLocationGranted() =
        ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
                PackageManager.PERMISSION_GRANTED

    // ─── Refresh UI ──────────────────────────────────────────────────────────

    private fun refreshUi() {
        val enrolled = AgentConfig.isEnrolled(this)

        if (enrolled) {
            val machineId  = AgentConfig.machineId(this)
            val socketOk   = AgentService.instance?.isSocketConnected == true
            tvStatus.text  = if (socketOk) "🟢 Conectado ao servidor" else "🟡 Conectando…"
            tvMachineId.text = "ID: $machineId"
            tvStatus.setTextColor(if (socketOk) 0xFF00C070.toInt() else 0xFFFFAA00.toInt())
            layoutEnroll.visibility  = View.GONE
            layoutPerms.visibility   = View.VISIBLE
            layoutActions.visibility = View.VISIBLE
        } else {
            tvStatus.text = "Não cadastrado"
            tvStatus.setTextColor(0xFFAAAAAA.toInt())
            tvMachineId.text = ""
            layoutEnroll.visibility  = View.VISIBLE
            layoutPerms.visibility   = View.GONE
            layoutActions.visibility = View.GONE
        }

        // Accessibility status
        val accessOk = isAccessibilityEnabled()
        tvAccess.text = if (accessOk) "● Controle remoto (Acessibilidade) ✓" else "● Controle remoto (Acessibilidade) — Necessário"
        tvAccess.setTextColor(if (accessOk) 0xFF00C070.toInt() else 0xFFFF5555.toInt())

        // Screen permission status
        val screenOk = AgentService.instance?.projectionResultCode == Activity.RESULT_OK
        tvScreen.text = if (screenOk) "● Captura de tela — Autorizada ✓" else "● Captura de tela — Necessária para tela remota"
        tvScreen.setTextColor(if (screenOk) 0xFF00C070.toInt() else 0xFFFF5555.toInt())

        // Location permission status
        val locOk = isLocationGranted()
        val locStr = NexusLocationManager.getLastLocation()?.let {
            "%.5f, %.5f (±${it.accuracy.toInt()}m)".format(it.latitude, it.longitude)
        }
        tvLocation.text = when {
            locOk && locStr != null -> "● Localização — $locStr ✓"
            locOk                   -> "● Localização — autorizada, aguardando fix…"
            else                    -> "● Localização — necessária para rastreamento"
        }
        tvLocation.setTextColor(if (locOk) 0xFF00C070.toInt() else 0xFFFFAA00.toInt())
        btnLocation.visibility = if (locOk) View.GONE else View.VISIBLE
    }

    private fun isAccessibilityEnabled(): Boolean {
        return InputAccessibilityService.instance != null ||
            runCatching {
                val enabled = Settings.Secure.getString(
                    contentResolver,
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
                ) ?: ""
                enabled.contains(packageName, ignoreCase = true)
            }.getOrDefault(false)
    }
}
