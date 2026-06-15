package br.com.nexusrmm.agent

import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/**
 * Localização com consumo mínimo de bateria.
 *
 * Estratégia de provedores (do mais econômico ao mais preciso):
 *   1. NETWORK_PROVIDER  — triangulação Wi-Fi/antenas de celular. ~1mW. Precisão ~50–200m.
 *      Ótimo para rastreamento empresarial: sabe o bairro, sala ou andar de forma eficiente.
 *   2. PASSIVE_PROVIDER  — "carona" no GPS de outros apps. Custo zero extra de hardware.
 *      Melhora a precisão quando outro app pede GPS sem custo adicional.
 *   NÃO ativa GPS_PROVIDER diretamente — esse consome ~100mW e drena a bateria.
 *
 * Intervalo: atualização a cada 5 minutos no mínimo, e somente se mover > 100m.
 * Isso significa, na prática, poucas dezenas de atualizações por dia de trabalho.
 */
object NexusLocationManager {
    private const val TAG = "NexusLocation"

    // 5 minutos — intervalo mínimo entre atualizações ativas
    private const val MIN_INTERVAL_MS   = 5 * 60 * 1_000L
    // 100 metros — não atualiza se o dispositivo mal se moveu
    private const val MIN_DISTANCE_M    = 100f

    @Volatile private var lastLocation: Location? = null
    private var locationManager: LocationManager? = null
    private val activeListeners = mutableListOf<LocationListener>()

    /** Inicia monitoramento. Chame após obter permissão ACCESS_COARSE_LOCATION. */
    fun start(ctx: Context) {
        stop() // garante que não há listeners duplicados
        try {
            val lm = ctx.applicationContext
                .getSystemService(Context.LOCATION_SERVICE) as LocationManager
            locationManager = lm

            // 1. Carrega o cache imediatamente — custo zero (leitura de memória)
            loadFromCache(lm)

            val listener = makeListener()

            // 2. Ativa NETWORK_PROVIDER (Wi-Fi + celular) — baixíssimo consumo
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER,
                    MIN_INTERVAL_MS,
                    MIN_DISTANCE_M,
                    listener,
                    Looper.getMainLooper(),
                )
                activeListeners.add(listener)
                Log.d(TAG, "NETWORK_PROVIDER ativo")
            }

            // 3. PASSIVE_PROVIDER — piggyback no GPS de outros apps, sem custo extra
            if (lm.isProviderEnabled(LocationManager.PASSIVE_PROVIDER)) {
                val passiveListener = makeListener()
                lm.requestLocationUpdates(
                    LocationManager.PASSIVE_PROVIDER,
                    MIN_INTERVAL_MS,
                    MIN_DISTANCE_M,
                    passiveListener,
                    Looper.getMainLooper(),
                )
                activeListeners.add(passiveListener)
                Log.d(TAG, "PASSIVE_PROVIDER ativo")
            }

            Log.i(TAG, "LocationManager iniciado. Cache: ${lastLocation?.let { "${it.latitude},${it.longitude}" } ?: "vazio"}")
        } catch (e: SecurityException) {
            Log.w(TAG, "Permissão de localização negada — LocationManager não iniciado")
        } catch (e: Exception) {
            Log.e(TAG, "Falha ao iniciar LocationManager: ${e.message}")
        }
    }

    /** Para o monitoramento e libera recursos. */
    fun stop() {
        try {
            val lm = locationManager ?: return
            activeListeners.forEach { lm.removeUpdates(it) }
        } catch (_: Exception) {}
        activeListeners.clear()
        locationManager = null
    }

    /** Última localização conhecida, ou null se ainda não temos nenhuma. */
    fun getLastLocation(): Location? = lastLocation

    /** Serializa para o payload do socket. Retorna null se não houver localização. */
    fun toJson(): JSONObject? {
        val loc = lastLocation ?: return null
        return JSONObject().apply {
            put("latitude",       loc.latitude)
            put("longitude",      loc.longitude)
            put("precisaoMetros", loc.accuracy.toDouble())
            put("capturadoEm",    loc.time)
            put("provedor",       loc.provider ?: "desconhecido")
        }
    }

    // ─── privado ──────────────────────────────────────────────────────────────

    private fun makeListener() = object : LocationListener {
        override fun onLocationChanged(loc: Location) {
            // Só aceita se for melhor que a atual (mais recente OU mais preciso)
            val prev = lastLocation
            if (prev == null || isBetterLocation(loc, prev)) {
                lastLocation = loc
                Log.d(TAG, "Localização atualizada: ${loc.latitude},${loc.longitude} " +
                        "acc=${loc.accuracy.toInt()}m via ${loc.provider}")
            }
        }

        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    /**
     * Decide se a nova localização é melhor que a anterior.
     * Critério: mais recente (>2min mais nova) OU mesma faixa de tempo com melhor precisão.
     */
    private fun isBetterLocation(novo: Location, atual: Location): Boolean {
        val deltaMs = novo.time - atual.time
        if (deltaMs > 2 * 60 * 1_000L) return true   // mais de 2 min mais nova → sempre melhor
        if (deltaMs < -2 * 60 * 1_000L) return false  // muito mais velha → pior
        // Mesma faixa de tempo: prefere maior precisão (menor accuracy = mais preciso)
        return novo.accuracy < atual.accuracy
    }

    private fun loadFromCache(lm: LocationManager) {
        try {
            val candidates = listOf(
                LocationManager.NETWORK_PROVIDER,
                LocationManager.GPS_PROVIDER,
                LocationManager.PASSIVE_PROVIDER,
            ).mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }

            // Escolhe o mais recente entre os candidatos
            lastLocation = candidates.maxByOrNull { it.time }
        } catch (e: SecurityException) {
            Log.w(TAG, "Sem permissão para cache de localização")
        }
    }
}
