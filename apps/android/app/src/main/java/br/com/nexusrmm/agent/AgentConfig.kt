package br.com.nexusrmm.agent

import android.content.Context
import android.util.Base64

/** Persistência das credenciais e configurações do agente (SharedPreferences). */
object AgentConfig {
    private const val PREFS = "nexus_agent_v1"

    private fun p(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isEnrolled(ctx: Context) = p(ctx).contains("machine_id")

    fun machineId(ctx: Context)    = p(ctx).getString("machine_id",    "") ?: ""
    fun serverUrl(ctx: Context)    = p(ctx).getString("server_url",    "") ?: ""
    fun gatewayUrl(ctx: Context)   = p(ctx).getString("gateway_url",   "") ?: ""
    fun clientCertPem(ctx: Context)= p(ctx).getString("client_cert",   "") ?: ""
    fun caCertPem(ctx: Context)    = p(ctx).getString("ca_cert",       "") ?: ""
    fun hostname(ctx: Context)     = p(ctx).getString("hostname",      "") ?: ""

    fun privateKeyBytes(ctx: Context): ByteArray? {
        val b64 = p(ctx).getString("priv_key_b64", null) ?: return null
        return Base64.decode(b64, Base64.DEFAULT)
    }

    fun save(
        ctx: Context,
        machineId: String,
        serverUrl: String,
        gatewayUrl: String,
        hostname: String,
        clientCertPem: String,
        caCertPem: String,
        privateKeyBytes: ByteArray,
    ) {
        p(ctx).edit().apply {
            putString("machine_id",   machineId)
            putString("server_url",   serverUrl)
            putString("gateway_url",  gatewayUrl)
            putString("hostname",     hostname)
            putString("client_cert",  clientCertPem)
            putString("ca_cert",      caCertPem)
            putString("priv_key_b64", Base64.encodeToString(privateKeyBytes, Base64.DEFAULT))
        }.apply()
    }

    fun clear(ctx: Context) = p(ctx).edit().clear().apply()

    /** Constrói a URL do gateway WebSocket a partir da URL do servidor.
     *  Ex: https://rmm.empresa.com -> wss://rmm.empresa.com:8443 */
    fun gatewayFromServer(serverUrl: String): String {
        val u = serverUrl.trimEnd('/')
        val wss = u.replace("https://", "wss://").replace("http://", "ws://")
        return if (wss.contains(":8443") || wss.contains(":8080")) wss
        else "$wss:8443"
    }
}
