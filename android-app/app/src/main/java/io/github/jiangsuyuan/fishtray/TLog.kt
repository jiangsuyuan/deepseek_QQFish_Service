package io.github.jiangsuyuan.fishtray

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 连接过程日志：内存环形缓冲 + 追加写文件。
 *
 * 为什么要有：APK 在手机上出问题时看不到控制台，只能靠它。
 * 主界面点状态条能看到，设置页点「测试连接」也能看到结果。
 */
object TLog {
    private const val MAX = 400
    private const val FILE = "tunnel.log"

    private val buf = ArrayDeque<String>()
    private val fmt = SimpleDateFormat("MM-dd HH:mm:ss", Locale.CHINA)
    private var file: File? = null

    fun init(ctx: Context) {
        if (file == null) file = File(ctx.applicationContext.filesDir, FILE)
    }

    @Synchronized
    fun add(tag: String, msg: String) {
        val line = "${fmt.format(Date())} [$tag] $msg"
        buf.addLast(line)
        while (buf.size > MAX) buf.removeFirst()
        Log.d("FishTray", line)
        // 落盘（失败就算了，不能因为日志挂掉主流程）
        runCatching {
            file?.appendText(line + "\n")
            // 文件太大就截断
            val f = file
            if (f != null && f.length() > 512 * 1024) {
                val keep = f.readLines().takeLast(1500)
                f.writeText(keep.joinToString("\n") + "\n")
            }
        }
    }

    @Synchronized
    fun dump(): String {
        if (buf.isEmpty()) {
            val f = file
            if (f != null && f.exists()) {
                return f.readLines().takeLast(200).joinToString("\n")
            }
            return "（还没有日志）"
        }
        return buf.joinToString("\n")
    }

    @Synchronized
    fun clear() {
        buf.clear()
        runCatching { file?.writeText("") }
    }

    /** 把异常的 cause 链摊平成一行，比 message 信息量大得多 */
    fun describe(e: Throwable): String {
        val sb = StringBuilder()
        var t: Throwable? = e
        var depth = 0
        while (t != null && depth < 6) {
            if (depth > 0) sb.append("  ←  ")
            sb.append(t.javaClass.simpleName)
            val m = t.message
            if (!m.isNullOrBlank()) sb.append(": ").append(m)
            t = t.cause
            depth++
            if (t === e) break
        }
        return sb.toString()
    }
}
