package io.github.jiangsuyuan.fishtray

import android.Manifest
import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var dot: View
    private lateinit var statusText: TextView
    private lateinit var overlay: View
    private lateinit var overlayText: TextView

    private var receiver: BroadcastReceiver? = null
    private var loadedOnce = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        AppCtx.init(this)
        Prefs.ensure()
        TLog.init(this)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        dot = findViewById(R.id.dot)
        statusText = findViewById(R.id.statusText)
        overlay = findViewById(R.id.overlay)
        overlayText = findViewById(R.id.overlayText)

        findViewById<Button>(R.id.btnReconnect).setOnClickListener {
            TunnelService.reconnect(this)
            render(TunnelService.STATE_CONNECTING, "正在重连…")
        }
        findViewById<Button>(R.id.btnSettings).setOnClickListener { goSettings() }
        // 点状态文字看连接日志 —— 连不上时这就是唯一的诊断入口
        statusText.setOnClickListener { showLog() }
        dot.setOnClickListener { showLog() }
        overlay.setOnClickListener {
            TunnelService.reconnect(this)
            render(TunnelService.STATE_CONNECTING, "正在重连…")
        }

        setupWeb()
        askNotificationPermission()
        maybeAskBattery()

        if (Prefs.isConfigured()) {
            TunnelService.start(this)
        } else {
            goSettings()
        }

        receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val st = i?.getIntExtra("state", TunnelService.STATE_DISCONNECTED)
                    ?: TunnelService.STATE_DISCONNECTED
                val msg = i?.getStringExtra("msg") ?: ""
                render(st, msg)
            }
        }
        val f = IntentFilter(TunnelService.BROADCAST_STATE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(receiver, f)
        }

        render(TunnelService.lastState, TunnelService.lastMsg)
    }

    private fun showLog() {
        AlertDialog.Builder(this)
            .setTitle("连接日志")
            .setMessage(TLog.dump())
            .setPositiveButton("关闭", null)
            .setNeutralButton("清空") { _, _ -> TLog.clear() }
            .setNegativeButton("重连") { _, _ -> TunnelService.reconnect(this) }
            .show()
    }

    private fun goSettings() {
        startActivity(Intent(this, SettingsActivity::class.java))
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWeb() {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            useWideViewPort = true
            loadWithOverviewMode = true
            builtInZoomControls = false
            displayZoomControls = false
            mediaPlaybackRequiresUserGesture = false
        }
        web.setBackgroundColor(0xFF12141A.toInt())
        web.overScrollMode = View.OVER_SCROLL_NEVER
        web.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                loadedOnce = true
                if (TunnelService.lastState == TunnelService.STATE_CONNECTED) hideOverlay()
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?,
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    loadedOnce = false
                    showOverlay("页面打不开 · 点这里重连")
                }
            }
        }
    }

    private fun render(state: Int, msg: String) {
        val color: Int
        val text: String
        when (state) {
            TunnelService.STATE_CONNECTED -> {
                color = 0xFF12B76A.toInt()
                text = "已连接"
            }
            TunnelService.STATE_CONNECTING -> {
                color = 0xFFF79009.toInt()
                text = "连接中"
            }
            else -> {
                color = 0xFFF04438.toInt()
                text = "断开"
            }
        }
        runCatching { dot.background?.setTint(color) }
        statusText.text = if (msg.isBlank()) text else "$text · $msg"

        if (state == TunnelService.STATE_CONNECTED) {
            hideOverlay()
            if (Prefs.isConfigured() && !loadedOnce) {
                web.loadUrl(Prefs.webUrl())
            }
        } else if (state == TunnelService.STATE_DISCONNECTED) {
            showOverlay("连接断开 · 点这里重连")
        }
    }

    private fun showOverlay(text: String) {
        overlayText.text = text
        overlay.visibility = View.VISIBLE
    }

    private fun hideOverlay() {
        overlay.visibility = View.GONE
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }
    }

    private fun maybeAskBattery() {
        val sp = getSharedPreferences("ui", MODE_PRIVATE)
        if (sp.getBoolean("battery_asked", false)) return
        sp.edit().putBoolean("battery_asked", true).apply()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            if (pm.isIgnoringBatteryOptimizations(packageName)) return
        }
        AlertDialog.Builder(this)
            .setTitle("让它一直连着")
            .setMessage(
                "安卓会清理后台，隧道可能被断掉。\n\n" +
                    "建议把本应用加入「允许后台运行 / 不限制电池」，并在多任务界面锁定。\n" +
                    "否则切出去一阵再回来，需要点一下「重连」。"
            )
            .setPositiveButton("去设置") { _, _ ->
                runCatching {
                    startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
                }
            }
            .setNegativeButton("知道了", null)
            .show()
    }

    override fun onBackPressed() {
        if (this::web.isInitialized && web.canGoBack()) {
            web.goBack()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    override fun onResume() {
        super.onResume()
        if (!Prefs.isConfigured()) return
        if (this::web.isInitialized && !loadedOnce && TunnelService.lastState == TunnelService.STATE_CONNECTED) {
            web.loadUrl(Prefs.webUrl())
        }
        if (this::web.isInitialized) TunnelService.start(this)
    }

    override fun onDestroy() {
        receiver?.let {
            runCatching { unregisterReceiver(it) }
        }
        super.onDestroy()
    }
}
