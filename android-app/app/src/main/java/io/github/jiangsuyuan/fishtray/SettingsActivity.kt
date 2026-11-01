package io.github.jiangsuyuan.fishtray

import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

class SettingsActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppCtx.init(this)
        setContentView(R.layout.activity_settings)

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

        findViewById<Button>(R.id.btnSave).setOnClickListener {
            val host = eHost.text.toString().trim()
            val user = eUser.text.toString().trim()
            val key = eKey.text.toString().trim()
            val token = eToken.text.toString().trim()
            if (host.isBlank() || user.isBlank() || key.isBlank() || token.isBlank()) {
                Toast.makeText(this, "服务器 / 用户名 / 私钥 / token 都不能空", Toast.LENGTH_LONG).show()
                return@setOnClickListener
            }
            if (!key.contains("PRIVATE KEY")) {
                Toast.makeText(this, "私钥看起来不对（应以 -----BEGIN ... PRIVATE KEY----- 开头）", Toast.LENGTH_LONG)
                    .show()
                return@setOnClickListener
            }
            Prefs.host = host
            Prefs.port = ePort.text.toString().trim().toIntOrNull() ?: 22
            Prefs.user = user
            Prefs.key = key
            Prefs.token = token
            Prefs.webPort = eWebPort.text.toString().trim().toIntOrNull() ?: 3081

            TunnelService.reconnect(this)
            Toast.makeText(this, "已保存，正在重连…", Toast.LENGTH_SHORT).show()
            finish()
        }

        findViewById<Button>(R.id.btnCancel).setOnClickListener { finish() }
    }
}
