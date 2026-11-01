package io.github.jiangsuyuan.fishtray

import android.app.ProgressDialog
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import android.text.Editable
import android.text.TextWatcher
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity

class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppCtx.init(this)
        setContentView(R.layout.activity_settings)
        TLog.init(this)

        val eHost = findViewById<EditText>(R.id.eHost)
        val ePort = findViewById<EditText>(R.id.ePort)
        val eUser = findViewById<EditText>(R.id.eUser)
        val eKey = findViewById<EditText>(R.id.eKey)
        val eToken = findViewById<EditText>(R.id.eToken)
        val eWebPort = findViewById<EditText>(R.id.eWebPort)

        eHost.setText(Prefs.host)
        ePort.setText(Prefs.port.toString())
        eUser.setText(Prefs.user)
        eKey.setText(Prefs.key)
        eToken.setText(Prefs.token)
        eWebPort.setText(Prefs.webPort.toString())

        // 私钥指纹实时显示：粘贴完立刻能看出是不是同一把
        val tvFp = findViewById<TextView>(R.id.tvKeyFp)
        fun refreshFp() {
            val fp = ConnTest.keyFingerprint(eKey.text.toString())
            tvFp.text = if (fp.isBlank()) "" else "私钥指纹：$fp"
            tvFp.setTextColor(
                if (fp.isBlank()) 0xFF8B93A1.toInt()
                else 0xFF4C8DFF.toInt()
            )
        }
        eKey.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun afterTextChanged(s: Editable?) = refreshFp()
        })
        refreshFp()

        fun collect(): Triple<String, Int, String>? {
            val host = eHost.text.toString().trim()
            val user = eUser.text.toString().trim()
            val key = eKey.text.toString()
            val token = eToken.text.toString().trim()
            if (host.isBlank() || user.isBlank() || key.isBlank() || token.isBlank()) {
                Toast.makeText(this, "服务器 / 用户名 / 私钥 / token 都不能空", Toast.LENGTH_LONG).show()
                return null
            }
            // IP 差一位这种最常见的错，提前查一下
            if (host.contains(" ") || host.startsWith("http")) {
                Toast.makeText(this, "服务器只填地址，不要带 http:// 或空格", Toast.LENGTH_LONG).show()
                return null
            }
            ConnTest.validateKey(key)?.let {
                AlertDialog.Builder(this)
                    .setTitle("私钥有问题")
                    .setMessage(it + "\n\n建议：把私钥当【文件】传到手机，用文本编辑器打开后全选复制，\n不要通过聊天消息里复制（会插换行、丢字符）。")
                    .setPositiveButton("知道了", null)
                    .show()
                return null
            }
            val p = ePort.text.toString().trim().toIntOrNull() ?: 22
            return Triple(host, p, key)
        }

        // 测试连接：真连一次，结果直接弹出来
        findViewById<Button>(R.id.btnTest).setOnClickListener {
            val c = collect() ?: return@setOnClickListener
            val user = eUser.text.toString().trim()
            val webPort = eWebPort.text.toString().trim().toIntOrNull() ?: 3081

            val dlg = ProgressDialog(this).apply {
                setMessage("正在连 ${c.first}:${c.second} …")
                setCancelable(false)
                show()
            }
            Thread {
                // 临时把 webPort 设进去，测试要用
                Prefs.webPort = webPort
                val r0 = ConnTest.test(c.first, c.second, user, c.third)
                val fp = ConnTest.keyFingerprint(c.third)
                val r = ConnTest.Result(
                    r0.ok,
                    r0.text + "\n\n本次用的私钥指纹：$fp",
                )
                runOnUiThread {
                    runCatching { dlg.dismiss() }
                    AlertDialog.Builder(this)
                        .setTitle(if (r.ok) "✅ 能连上" else "❌ 连不上")
                        .setMessage(r.text)
                        .setPositiveButton("知道了", null)
                        .setNeutralButton("看日志") { _, _ -> showLog() }
                        .show()
                }
            }.start()
        }

        findViewById<Button>(R.id.btnSave).setOnClickListener {
            val c = collect() ?: return@setOnClickListener
            Prefs.host = c.first
            Prefs.port = c.second
            Prefs.user = eUser.text.toString().trim()
            Prefs.key = c.third.trim()
            Prefs.token = eToken.text.toString().trim()
            Prefs.webPort = eWebPort.text.toString().trim().toIntOrNull() ?: 3081
            TLog.add("cfg", "配置已保存 → ${c.first}:${c.second} user=${Prefs.user} webPort=${Prefs.webPort}")

            TunnelService.reconnect(this)
            Toast.makeText(this, "已保存，正在重连…", Toast.LENGTH_SHORT).show()
            finish()
        }

        findViewById<Button>(R.id.btnCancel).setOnClickListener { finish() }
        findViewById<Button>(R.id.btnLog).setOnClickListener { showLog() }
    }

    private fun showLog() {
        AlertDialog.Builder(this)
            .setTitle("连接日志")
            .setMessage(TLog.dump())
            .setPositiveButton("关闭", null)
            .setNeutralButton("清空") { _, _ -> TLog.clear() }
            .show()
    }
}
