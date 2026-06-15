package br.com.nexusrmm.agent

import android.app.ActivityManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.text.format.Formatter
import org.json.JSONArray
import org.json.JSONObject

object InventoryManager {

    /** Coleta inventário completo do dispositivo — enviado via agent:inventory */
    fun collect(ctx: Context): JSONObject {
        val machineId = AgentConfig.machineId(ctx)

        return JSONObject().apply {
            put("machineId",   machineId)
            put("capturadoEm", System.currentTimeMillis())
            put("hardware",    hardware(ctx))
            put("so",          so())
            put("rede",        rede(ctx))
            put("software",    software(ctx))
            put("tipoMaquina", tipoMaquina(ctx))
        }
    }

    /** Coleta métricas leves (CPU/RAM) — enviado via agent:metrics a cada 20s */
    fun metricas(ctx: Context): JSONObject {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val total = mem.totalMem.toDouble()
        val ramPct = if (total > 0) ((total - mem.availMem) / total * 100).toInt() else 0

        // CPU: Android não expõe facilmente sem root; usar load da JVM como proxy
        val cpuLoad = runCatching {
            val pid = android.os.Process.myPid()
            val stat = java.io.File("/proc/$pid/stat").readText().split(" ")
            stat[13].toLong() + stat[14].toLong() // utime + stime ticks do processo
        }.getOrDefault(0L)

        return JSONObject().apply {
            put("cpu", 0)   // sem acesso a /proc/stat sem root — retorna 0
            put("ram", ramPct)
            put("em",  System.currentTimeMillis())
        }
    }

    // ─────────────────────────────────────────────────────────────────────────

    private fun hardware(ctx: Context): JSONObject {
        val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
        val sf = StatFs(Environment.getDataDirectory().absolutePath)

        return JSONObject().apply {
            put("cpu", JSONObject().apply {
                put("modelo",  "${Build.HARDWARE} / ${Build.BOARD}")
                put("cores",   Runtime.getRuntime().availableProcessors())
                put("threads", Runtime.getRuntime().availableProcessors())
            })
            put("ram", JSONObject().apply {
                put("totalBytes", mem.totalMem)
            })
            put("discos", JSONArray().apply {
                put(JSONObject().apply {
                    put("caminho",      "/data")
                    put("tamanhoBytes", sf.totalBytes)
                    put("livreBytes",   sf.availableBytes)
                })
            })
            put("fabricante",  Build.MANUFACTURER)
            put("modeloPlaca", "${Build.MANUFACTURER} ${Build.MODEL}")
        }
    }

    private fun so(): JSONObject = JSONObject().apply {
        put("nome",          "Android ${Build.VERSION.RELEASE}")
        put("versao",        Build.VERSION.SDK_INT.toString())
        put("arquitetura",   Build.SUPPORTED_ABIS.firstOrNull() ?: "unknown")
        put("dataInstalacao", JSONObject.NULL)
        put("bootTime",      JSONObject.NULL)
    }

    private fun rede(ctx: Context): JSONArray {
        val arr = JSONArray()
        runCatching {
            val wm = ctx.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            val wi = wm?.connectionInfo
            val mac = wi?.macAddress ?: "02:00:00:00:00:00"
            val ip  = wi?.ipAddress?.takeIf { it != 0 }?.let { Formatter.formatIpAddress(it) } ?: ""
            arr.put(JSONObject().apply {
                put("interface", "wlan0")
                put("mac",  mac)
                put("ips",  JSONArray().apply { if (ip.isNotEmpty()) put(ip) })
            })
        }
        // Adicionar também interfaces via java.net.NetworkInterface
        runCatching {
            java.net.NetworkInterface.getNetworkInterfaces()?.toList()?.forEach { iface ->
                if (iface.name == "wlan0") return@forEach  // já adicionado acima
                val ips = iface.inetAddresses.toList()
                    .filterNot { it.isLoopbackAddress }
                    .mapNotNull { it.hostAddress }
                if (ips.isEmpty()) return@forEach
                arr.put(JSONObject().apply {
                    put("interface", iface.name)
                    put("mac", iface.hardwareAddress
                        ?.joinToString(":") { "%02x".format(it) } ?: "")
                    put("ips", JSONArray(ips))
                })
            }
        }
        return arr
    }

    private fun software(ctx: Context): JSONArray {
        val arr = JSONArray()
        runCatching {
            val pm = ctx.packageManager
            @Suppress("DEPRECATION")
            val pkgs = pm.getInstalledPackages(PackageManager.GET_META_DATA)
            var count = 0
            for (pkg in pkgs) {
                if (count >= 300) break
                val ai = pkg.applicationInfo ?: continue
                if (ai.flags and ApplicationInfo.FLAG_SYSTEM != 0) continue  // pular apps do sistema
                val label = pm.getApplicationLabel(ai).toString()
                arr.put(JSONObject().apply {
                    put("nome",           label)
                    put("versao",         pkg.versionName ?: "")
                    put("fornecedor",     pkg.packageName)
                    put("dataInstalacao", JSONObject.NULL)
                })
                count++
            }
        }
        return arr
    }

    private fun tipoMaquina(ctx: Context): String {
        val cfg = ctx.resources.configuration
        val size = cfg.screenLayout and android.content.res.Configuration.SCREENLAYOUT_SIZE_MASK
        return if (size >= android.content.res.Configuration.SCREENLAYOUT_SIZE_LARGE) "tablet" else "mobile"
    }
}
