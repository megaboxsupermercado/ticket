package br.com.megabox.senhas

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.hardware.usb.UsbManager
import android.os.Build
import java.io.ByteArrayOutputStream
import java.text.Normalizer

/**
 * Imprime o ticket da senha numa Epson TM-T20X ligada por USB,
 * enviando comandos ESC/POS direto pelo cabo (sem driver e sem SDK).
 */
class ImpressoraUsb(private val context: Context) {

    companion object {
        const val ACAO_PERMISSAO = "br.com.megabox.senhas.PERMISSAO_USB"
        private const val EPSON_VENDOR_ID = 0x04B8
        private const val LARGURA_LOGO = 384 // pontos; o papel de 80 mm tem 576
    }

    private val usb = context.getSystemService(Context.USB_SERVICE) as UsbManager
    private val logo: ByteArray? by lazy { carregarLogo() }

    fun encontrar(): UsbDevice? =
        usb.deviceList.values.firstOrNull { it.vendorId == EPSON_VENDOR_ID }
            ?: usb.deviceList.values.firstOrNull { d -> interfaceImpressora(d) != null }

    fun pedirPermissao() {
        val d = encontrar() ?: return
        if (usb.hasPermission(d)) return
        val flags = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        val pi = PendingIntent.getBroadcast(
            context, 0, Intent(ACAO_PERMISSAO).setPackage(context.packageName), flags
        )
        usb.requestPermission(d, pi)
    }

    /** Retorna "ok" ou uma mensagem de erro curta. */
    @Synchronized
    fun imprimir(codigo: String, tipo: String, data: String, hora: String): String {
        val d = encontrar() ?: return "Impressora não encontrada no USB"
        if (!usb.hasPermission(d)) {
            pedirPermissao()
            return "Sem permissão para usar a impressora"
        }
        val (intf, saida) = interfaceImpressora(d) ?: return "Impressora sem saída USB compatível"
        val con = usb.openDevice(d) ?: return "Não foi possível abrir a impressora"
        try {
            if (!con.claimInterface(intf, true)) return "Impressora ocupada"
            val dados = montarTicket(codigo, tipo, data, hora)
            var enviado = 0
            while (enviado < dados.size) {
                val n = minOf(16384, dados.size - enviado)
                val r = con.bulkTransfer(saida, dados, enviado, n, 5000)
                if (r <= 0) return "Falha ao enviar para a impressora"
                enviado += r
            }
            con.releaseInterface(intf)
            return "ok"
        } finally {
            con.close()
        }
    }

    private fun interfaceImpressora(d: UsbDevice): Pair<UsbInterface, UsbEndpoint>? {
        for (i in 0 until d.interfaceCount) {
            val intf = d.getInterface(i)
            for (e in 0 until intf.endpointCount) {
                val ep = intf.getEndpoint(e)
                if (ep.type == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.direction == UsbConstants.USB_DIR_OUT) {
                    return intf to ep
                }
            }
        }
        return null
    }

    // ---------- Ticket em ESC/POS ----------
    private fun montarTicket(codigo: String, tipo: String, data: String, hora: String): ByteArray {
        val b = ByteArrayOutputStream()
        fun cmd(vararg x: Int) = x.forEach { b.write(it) }
        fun txt(s: String) = b.write(semAcento(s).toByteArray(Charsets.US_ASCII))

        cmd(0x1B, 0x40)            // inicializa
        cmd(0x1B, 0x61, 1)         // centraliza
        logo?.let { b.write(it); txt("\n") }
        cmd(0x1D, 0x21, 0x11); cmd(0x1B, 0x45, 1)   // texto 2x, negrito
        txt("ACOUGUE\n")
        cmd(0x1D, 0x21, 0x00); cmd(0x1B, 0x45, 0)
        txt("\n$tipo\n")
        cmd(0x1D, 0x21, 0x55); cmd(0x1B, 0x45, 1)   // senha bem grande (6x)
        txt("$codigo\n")
        cmd(0x1D, 0x21, 0x00); cmd(0x1B, 0x45, 0)
        txt("\n$data  $hora\n")
        txt("Aguarde ser chamado no painel\n")
        cmd(0x1B, 0x64, 4)         // avança 4 linhas
        cmd(0x1D, 0x56, 0x42, 0)   // corta o papel
        return b.toByteArray()
    }

    private fun semAcento(s: String): String =
        Normalizer.normalize(s, Normalizer.Form.NFD).replace(Regex("\\p{M}"), "").replace(Regex("[^\\x20-\\x7E\\n]"), "")

    /** Converte a logo (assets/logo.png) em imagem preto e branco no formato GS v 0. */
    private fun carregarLogo(): ByteArray? = try {
        val orig = context.assets.open("logo.png").use { BitmapFactory.decodeStream(it) }
        val alt = (orig.height * LARGURA_LOGO / orig.width.toFloat()).toInt()
        val bmp = Bitmap.createScaledBitmap(orig, LARGURA_LOGO, alt, true)
        val bytesLinha = LARGURA_LOGO / 8
        val out = ByteArrayOutputStream()
        out.write(byteArrayOf(0x1D, 0x76, 0x30, 0x00))
        out.write(bytesLinha and 0xFF); out.write(bytesLinha shr 8)
        out.write(alt and 0xFF); out.write(alt shr 8)
        for (y in 0 until alt) {
            for (xb in 0 until bytesLinha) {
                var v = 0
                for (bit in 0 until 8) {
                    val p = bmp.getPixel(xb * 8 + bit, y)
                    val lum = (Color.red(p) * 299 + Color.green(p) * 587 + Color.blue(p) * 114) / 1000
                    if (Color.alpha(p) > 128 && lum < 150) v = v or (0x80 shr bit)
                }
                out.write(v)
            }
        }
        out.toByteArray()
    } catch (e: Exception) {
        null
    }
}
