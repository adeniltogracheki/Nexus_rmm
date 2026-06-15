package br.com.nexusrmm.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject

/**
 * Serviço de Acessibilidade do Nexus RMM.
 * Injeta toques e teclas a partir de comandos JSON enviados pelo relay de tela.
 * Deve ser ativado em Configurações → Acessibilidade → Nexus RMM Control.
 */
class InputAccessibilityService : AccessibilityService() {

    companion object {
        @Volatile
        var instance: InputAccessibilityService? = null

        // Windows VK codes → Android KeyEvent keycodes
        val VK_TO_KEYCODE = mapOf(
            8   to KeyEvent.KEYCODE_DEL,
            9   to KeyEvent.KEYCODE_TAB,
            13  to KeyEvent.KEYCODE_ENTER,
            16  to KeyEvent.KEYCODE_SHIFT_LEFT,
            17  to KeyEvent.KEYCODE_CTRL_LEFT,
            18  to KeyEvent.KEYCODE_ALT_LEFT,
            19  to KeyEvent.KEYCODE_BREAK,
            20  to KeyEvent.KEYCODE_CAPS_LOCK,
            27  to KeyEvent.KEYCODE_ESCAPE,
            32  to KeyEvent.KEYCODE_SPACE,
            33  to KeyEvent.KEYCODE_PAGE_UP,
            34  to KeyEvent.KEYCODE_PAGE_DOWN,
            35  to KeyEvent.KEYCODE_MOVE_END,
            36  to KeyEvent.KEYCODE_MOVE_HOME,
            37  to KeyEvent.KEYCODE_DPAD_LEFT,
            38  to KeyEvent.KEYCODE_DPAD_UP,
            39  to KeyEvent.KEYCODE_DPAD_RIGHT,
            40  to KeyEvent.KEYCODE_DPAD_DOWN,
            45  to KeyEvent.KEYCODE_INSERT,
            46  to KeyEvent.KEYCODE_FORWARD_DEL,
            48  to KeyEvent.KEYCODE_0,  49  to KeyEvent.KEYCODE_1,
            50  to KeyEvent.KEYCODE_2,  51  to KeyEvent.KEYCODE_3,
            52  to KeyEvent.KEYCODE_4,  53  to KeyEvent.KEYCODE_5,
            54  to KeyEvent.KEYCODE_6,  55  to KeyEvent.KEYCODE_7,
            56  to KeyEvent.KEYCODE_8,  57  to KeyEvent.KEYCODE_9,
            65  to KeyEvent.KEYCODE_A,  66  to KeyEvent.KEYCODE_B,
            67  to KeyEvent.KEYCODE_C,  68  to KeyEvent.KEYCODE_D,
            69  to KeyEvent.KEYCODE_E,  70  to KeyEvent.KEYCODE_F,
            71  to KeyEvent.KEYCODE_G,  72  to KeyEvent.KEYCODE_H,
            73  to KeyEvent.KEYCODE_I,  74  to KeyEvent.KEYCODE_J,
            75  to KeyEvent.KEYCODE_K,  76  to KeyEvent.KEYCODE_L,
            77  to KeyEvent.KEYCODE_M,  78  to KeyEvent.KEYCODE_N,
            79  to KeyEvent.KEYCODE_O,  80  to KeyEvent.KEYCODE_P,
            81  to KeyEvent.KEYCODE_Q,  82  to KeyEvent.KEYCODE_R,
            83  to KeyEvent.KEYCODE_S,  84  to KeyEvent.KEYCODE_T,
            85  to KeyEvent.KEYCODE_U,  86  to KeyEvent.KEYCODE_V,
            87  to KeyEvent.KEYCODE_W,  88  to KeyEvent.KEYCODE_X,
            89  to KeyEvent.KEYCODE_Y,  90  to KeyEvent.KEYCODE_Z,
            91  to KeyEvent.KEYCODE_META_LEFT,
            92  to KeyEvent.KEYCODE_META_RIGHT,
            96  to KeyEvent.KEYCODE_NUMPAD_0,
            97  to KeyEvent.KEYCODE_NUMPAD_1,
            98  to KeyEvent.KEYCODE_NUMPAD_2,
            99  to KeyEvent.KEYCODE_NUMPAD_3,
            100 to KeyEvent.KEYCODE_NUMPAD_4,
            101 to KeyEvent.KEYCODE_NUMPAD_5,
            102 to KeyEvent.KEYCODE_NUMPAD_6,
            103 to KeyEvent.KEYCODE_NUMPAD_7,
            104 to KeyEvent.KEYCODE_NUMPAD_8,
            105 to KeyEvent.KEYCODE_NUMPAD_9,
            106 to KeyEvent.KEYCODE_NUMPAD_MULTIPLY,
            107 to KeyEvent.KEYCODE_NUMPAD_ADD,
            109 to KeyEvent.KEYCODE_NUMPAD_SUBTRACT,
            110 to KeyEvent.KEYCODE_NUMPAD_DOT,
            111 to KeyEvent.KEYCODE_NUMPAD_DIVIDE,
            112 to KeyEvent.KEYCODE_F1,  113 to KeyEvent.KEYCODE_F2,
            114 to KeyEvent.KEYCODE_F3,  115 to KeyEvent.KEYCODE_F4,
            116 to KeyEvent.KEYCODE_F5,  117 to KeyEvent.KEYCODE_F6,
            118 to KeyEvent.KEYCODE_F7,  119 to KeyEvent.KEYCODE_F8,
            120 to KeyEvent.KEYCODE_F9,  121 to KeyEvent.KEYCODE_F10,
            122 to KeyEvent.KEYCODE_F11, 123 to KeyEvent.KEYCODE_F12,
            144 to KeyEvent.KEYCODE_NUM_LOCK,
            186 to KeyEvent.KEYCODE_SEMICOLON,
            187 to KeyEvent.KEYCODE_EQUALS,
            188 to KeyEvent.KEYCODE_COMMA,
            189 to KeyEvent.KEYCODE_MINUS,
            190 to KeyEvent.KEYCODE_PERIOD,
            191 to KeyEvent.KEYCODE_SLASH,
            192 to KeyEvent.KEYCODE_GRAVE,
            219 to KeyEvent.KEYCODE_LEFT_BRACKET,
            220 to KeyEvent.KEYCODE_BACKSLASH,
            221 to KeyEvent.KEYCODE_RIGHT_BRACKET,
            222 to KeyEvent.KEYCODE_APOSTROPHE,
        )
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    override fun onDestroy() {
        super.onDestroy()
        if (instance === this) instance = null
    }

    /** Processa um comando JSON vindo do relay (mouse, scroll, key). */
    fun handleCommand(json: JSONObject) {
        val sw = resources.displayMetrics.widthPixels.toFloat()
        val sh = resources.displayMetrics.heightPixels.toFloat()
        when (json.optString("cmd")) {
            "mouse"  -> handleMouse(json, sw, sh)
            "scroll" -> handleScroll(json, sw, sh)
            "key"    -> handleKey(json)
        }
    }

    // ─── Touch ───────────────────────────────────────────────────────────────

    private var lastButtons = 0
    private var downX = 0f
    private var downY = 0f
    private var downTime = 0L

    private fun handleMouse(json: JSONObject, sw: Float, sh: Float) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        val x = (json.optDouble("x", 0.5) * sw).toFloat().coerceIn(0f, sw)
        val y = (json.optDouble("y", 0.5) * sh).toFloat().coerceIn(0f, sh)
        val buttons = json.optInt("buttons", 0)

        if (buttons > 0 && lastButtons == 0) {
            // Pointer down
            downX = x; downY = y; downTime = System.currentTimeMillis()
        } else if (buttons == 0 && lastButtons > 0) {
            // Pointer up — dispatch o gesto completo
            val duration = (System.currentTimeMillis() - downTime).coerceAtLeast(50L)
            val path = Path().apply {
                moveTo(downX, downY)
                if (Math.abs(x - downX) > 2 || Math.abs(y - downY) > 2) lineTo(x, y)
            }
            val stroke = GestureDescription.StrokeDescription(path, 0, duration)
            dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
        }
        lastButtons = buttons
    }

    private fun handleScroll(json: JSONObject, sw: Float, sh: Float) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return
        val x = (json.optDouble("x", 0.5) * sw).toFloat()
        val y = (json.optDouble("y", 0.5) * sh).toFloat()
        val delta = json.optDouble("delta", 0.0).toFloat()
        val endY  = (y - delta * 250f).coerceIn(0f, sh)
        val path  = Path().apply { moveTo(x, y); lineTo(x, endY) }
        val stroke= GestureDescription.StrokeDescription(path, 0, 300)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    // ─── Keys ────────────────────────────────────────────────────────────────

    private fun handleKey(json: JSONObject) {
        val vk   = json.optInt("vk", 0)
        val down = json.optBoolean("down", false)
        if (!down) return  // Accessibility só processa key-down para global actions

        when (vk) {
            0x24 -> performGlobalAction(GLOBAL_ACTION_HOME)         // Home
            0x5B, 0x5C -> performGlobalAction(GLOBAL_ACTION_HOME)   // Win key → Home
            // Não temos F4, recentes, etc. mapeados para global action — ignorar
        }
        // Teclas regulares via inject (funciona quando o foco está em um campo de texto)
        val keycode = VK_TO_KEYCODE[vk] ?: return
        // AccessibilityService não tem injectInputEvent sem root.
        // Para campos de texto, usamos performAction(ACTION_SET_TEXT) ou deixamos o
        // InputMethodService lidar — aqui apenas logamos.
        // Implementação completa de teclado requer root ou InputMethodService customizado.
    }
}
