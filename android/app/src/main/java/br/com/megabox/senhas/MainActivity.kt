package br.com.megabox.senhas

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

/**
 * Totem de senhas: mostra a tela /totem do sistema em tela cheia e
 * imprime o ticket na Epson TM-T20X pelo USB.
 *
 * Para abrir a configuração: toque 7 vezes seguidas no canto superior esquerdo.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var impressora: ImpressoraUsb
    private val prefs by lazy { getSharedPreferences("totem", Context.MODE_PRIVATE) }
    private val handler = Handler(Looper.getMainLooper())

    private var toquesCanto = 0
    private var ultimoToque = 0L

    private val receptorUsb = object : BroadcastReceiver() {
        override fun onReceive(c: Context, i: Intent) { /* permissão concedida ou negada: nada a fazer */ }
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        impressora = ImpressoraUsb(this)

        val filtro = IntentFilter(ImpressoraUsb.ACAO_PERMISSAO)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(receptorUsb, filtro, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(receptorUsb, filtro)

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            setBackgroundColor(Color.parseColor("#FFC300"))
            isLongClickable = false
            setOnLongClickListener { true }
            addJavascriptInterface(Ponte(), "AndroidImpressora")
            webViewClient = object : WebViewClient() {
                override fun onReceivedError(v: WebView, r: WebResourceRequest, e: WebResourceError) {
                    // Sem internet: tenta de novo a cada 15 segundos.
                    if (r.isForMainFrame) handler.postDelayed({ carregar() }, 15000)
                }
            }
        }

        val raiz = FrameLayout(this)
        raiz.addView(web)
        // Área invisível no canto para abrir a configuração.
        val canto = View(this).apply {
            setOnTouchListener { _, ev ->
                if (ev.action == MotionEvent.ACTION_DOWN) contarToqueCanto()
                false
            }
        }
        raiz.addView(canto, FrameLayout.LayoutParams(120, 120, Gravity.TOP or Gravity.START))
        setContentView(raiz)

        if (prefs.getString("servidor", "").isNullOrBlank()) configurar() else carregar()
        impressora.pedirPermissao()
    }

    override fun onResume() {
        super.onResume()
        telaCheia()
        // Fixa o app na tela (o Android pede confirmação na primeira vez).
        try { startLockTask() } catch (_: Exception) {}
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) telaCheia()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { /* o botão voltar não sai do totem */ }

    override fun onDestroy() {
        unregisterReceiver(receptorUsb)
        super.onDestroy()
    }

    private fun telaCheia() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            or View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            or View.SYSTEM_UI_FLAG_LAYOUT_STABLE or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION)
    }

    private fun carregar() {
        val servidor = prefs.getString("servidor", "")!!.trimEnd('/')
        val chave = prefs.getString("chave", "")!!
        web.loadUrl("$servidor/totem?chave=" + android.net.Uri.encode(chave))
    }

    private fun contarToqueCanto() {
        val agora = System.currentTimeMillis()
        toquesCanto = if (agora - ultimoToque < 800) toquesCanto + 1 else 1
        ultimoToque = agora
        if (toquesCanto >= 7) { toquesCanto = 0; configurar() }
    }

    private fun configurar() {
        val caixa = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 24, 48, 0) }
        val servidor = EditText(this).apply {
            hint = "Endereço do sistema (ex.: https://senhas.exemplo.com)"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(prefs.getString("servidor", ""))
        }
        val chave = EditText(this).apply {
            hint = "Chave da loja"
            setText(prefs.getString("chave", ""))
        }
        val info = TextView(this).apply {
            text = if (impressora.encontrar() != null) "Impressora Epson encontrada no USB." else "Impressora não encontrada no USB."
        }
        caixa.addView(servidor); caixa.addView(chave); caixa.addView(info)

        AlertDialog.Builder(this)
            .setTitle("Configurar totem")
            .setView(caixa)
            .setCancelable(false)
            .setPositiveButton("Salvar") { _, _ ->
                prefs.edit().putString("servidor", servidor.text.toString().trim())
                    .putString("chave", chave.text.toString().trim()).apply()
                carregar()
            }
            .setNeutralButton("Imprimir teste") { _, _ ->
                val r = impressora.imprimir("N000", "TESTE", "--/--/----", "--:--")
                AlertDialog.Builder(this).setMessage(if (r == "ok") "Teste enviado para a impressora." else r)
                    .setPositiveButton("OK") { _, _ -> configurar() }.show()
            }
            .setNegativeButton("Sair do app") { _, _ ->
                try { stopLockTask() } catch (_: Exception) {}
                finishAndRemoveTask()
            }
            .show()
    }

    /** Chamado pela página do totem: window.AndroidImpressora.imprimir(json). */
    inner class Ponte {
        @JavascriptInterface
        fun imprimir(json: String): String = try {
            val j = JSONObject(json)
            impressora.imprimir(j.getString("codigo"), j.optString("tipo"), j.optString("data"), j.optString("hora"))
        } catch (e: Exception) {
            "Erro ao imprimir: ${e.message}"
        }
    }
}
