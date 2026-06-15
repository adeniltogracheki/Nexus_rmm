package br.com.nexusrmm.agent

import android.content.Context
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.URL
import java.security.KeyPairGenerator
import java.security.interfaces.RSAPrivateKey
import javax.net.ssl.HttpsURLConnection

object EnrollManager {
    private const val TAG = "EnrollManager"
    const val AGENT_VERSION = "0.7.0-android"

    data class EnrollResult(
        val machineId: String,
        val clientCertPem: String,
        val caCertPem: String,
        val privateKey: RSAPrivateKey,
        val hostname: String,
    )

    suspend fun enroll(
        ctx: Context,
        serverUrl: String,
        token: String,
    ): Result<EnrollResult> = withContext(Dispatchers.IO) {
        runCatching {
            // 1. Gerar par RSA-2048
            val kpg = KeyPairGenerator.getInstance("RSA")
            kpg.initialize(2048)
            val kp = kpg.generateKeyPair()

            // 2. Public key em formato PEM (SubjectPublicKeyInfo — compatível com node-forge)
            val pubB64 = Base64.encodeToString(kp.public.encoded, Base64.DEFAULT)
            val pubPem = "-----BEGIN PUBLIC KEY-----\n$pubB64-----END PUBLIC KEY-----\n"

            // 3. Identificadores do dispositivo
            val androidId = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
            val hostname = "${Build.MANUFACTURER} ${Build.MODEL}".trim()
            val soVersao = "Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})"
            val tipoMaquina = if (isTablet(ctx)) "tablet" else "mobile"

            // 4. POST /api/enroll
            val body = JSONObject().apply {
                put("token",          token)
                put("hostname",       hostname)
                put("chavePublicaPem", pubPem)
                put("soVersao",       soVersao)
                put("versaoAgente",   AGENT_VERSION)
                put("biosUuid",       androidId)
                put("tipoMaquina",    tipoMaquina)
            }

            val url = URL("${serverUrl.trimEnd('/')}/api/enroll")
            val conn = (url.openConnection() as java.net.HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                doOutput = true
                connectTimeout = 15_000
                readTimeout = 15_000
                // C6: usar o trust store padrão do Android (CA pública — Let's Encrypt).
                // Não sobrescrever SSLSocketFactory: se o servidor tiver cert válido, funciona.
                // Se o servidor usar CA privada, o admin deve instalar o perfil de CA no dispositivo.
            }

            OutputStreamWriter(conn.outputStream).use { it.write(body.toString()) }

            val code = conn.responseCode
            if (code != 200 && code != 201) {
                val err = conn.errorStream?.reader()?.readText() ?: "HTTP $code"
                throw Exception("Enrollment falhou ($code): $err")
            }

            val resp = JSONObject(conn.inputStream.reader().readText())
            if (BuildConfig.DEBUG) Log.d(TAG, "Enrolled machineId=${resp.getString("machineId")}")

            EnrollResult(
                machineId    = resp.getString("machineId"),
                clientCertPem= resp.getString("certificadoClientePem"),
                caCertPem    = resp.getString("certificadoCaPem"),
                privateKey   = kp.private as RSAPrivateKey,
                hostname     = hostname,
            )
        }
    }

    private fun isTablet(ctx: Context): Boolean {
        val config = ctx.resources.configuration
        val screenLayout = config.screenLayout and android.content.res.Configuration.SCREENLAYOUT_SIZE_MASK
        return screenLayout >= android.content.res.Configuration.SCREENLAYOUT_SIZE_LARGE
    }

}
