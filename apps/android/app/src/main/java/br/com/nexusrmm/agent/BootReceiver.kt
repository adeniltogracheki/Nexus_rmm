package br.com.nexusrmm.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/** Inicia o AgentService automaticamente ao ligar o dispositivo. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action !in listOf(
                Intent.ACTION_BOOT_COMPLETED,
                Intent.ACTION_MY_PACKAGE_REPLACED,
            )
        ) return

        if (!AgentConfig.isEnrolled(ctx)) {
            Log.d("BootReceiver", "Not enrolled — skip auto-start")
            return
        }

        Log.d("BootReceiver", "Boot completed — starting AgentService")
        val svc = Intent(ctx, AgentService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            ctx.startForegroundService(svc)
        else
            ctx.startService(svc)
    }
}
