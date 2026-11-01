package io.github.jiangsuyuan.fishtray

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log
import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.net.HttpURLConnection
import java.net.URL

/**
 * SSH 隧道前台服务。
 *
 * 做三件事：
 *  1. 用 JSch 连服务器，把远端 127.0.0.1:3081 转发到本机 127.0.0.1:3081
 *  2. 心跳：Session.isConnected() + 每 15 秒 HTTP 探一次 /history
 *  3. 断了按指数退避重连（3s → 6s → 12s → … → 上限 60s）
 *
 * 状态通过广播发给 MainActivity，同时更新通知栏（前台服务必须常驻通知）。
 */
class TunnelService : Service() {

    companion object {
        private const val TAG = "FishTunnel"
        private const val CH_ID = "fish_tunnel"
        private const val NOTI_ID = 1001
        private const val WEB_PORT_DEFAULT = 3081

        const val ACTION_START = "io.github.jiangsuyuan.fishtray.START"
        const val ACTION_RECONNECT = "io.github.jiangsuyuan.fishtray.RECONNECT"
        const val ACTION_STOP = "io.github.jiangsuyuan.fishtray.STOP"

        /** 状态广播：extra "state" = STATE_*，extra "msg" = 说明 */
        const val BROADCAST_STATE = "io.github.jiangsuyuan.fishtray.STATE"
        const val STATE_CONNECTING = 0
        const val STATE_CONNECTED = 1
        const val STATE_DISCONNECTED = 2

        @Volatile
        var lastState: Int = STATE_DISCONNECTED
        @Volatile
        var lastMsg: String = "未连接"

        fun start(ctx: Context) {
            val i = Intent(ctx, TunnelService::class.java).setAction(ACTION_START)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        fun reconnect(ctx: Context) {
            val i = Intent(ctx, TunnelService::class.java).setAction(ACTION_RECONNECT)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(i)
            } else {
                ctx.startService(i)
            }
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, TunnelService::class.java).setAction(ACTION_STOP))
        }
    }

    private var session: Session? = null
    private var scope: CoroutineScope? = null
    private var worker: Job? = null

    @Volatile
    private var wantRun = false
    private var attempt = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannel()
        TLog.init(this)
        TLog.add("svc", "服务创建")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                TLog.add("svc", "收到停止")
                wantRun = false
                teardown()
                broadcast(STATE_DISCONNECTED, "已断开")
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_RECONNECT -> {
                TLog.add("svc", "收到重连")
                wantRun = true
                startForegroundCompat()
                // 强制重建：先拆后连
                worker?.cancel()
                teardown()
                attempt = 0
                spawnWorker()
                return START_STICKY
            }
            else -> {
                wantRun = true
                startForegroundCompat()
                if (worker == null || worker?.isActive != true) {
                    spawnWorker()
                }
                return START_STICKY
            }
        }
    }

    private fun spawnWorker() {
        val sc = scope ?: CoroutineScope(Dispatchers.IO + SupervisorJob()).also { scope = it }
        worker = sc.launch {
            while (isActive && wantRun) {
                val ok = try {
                    connectOnce()
                } catch (e: Exception) {
                    val detail = TLog.describe(e)
                    TLog.add("ssh", "连接失败：${detail}")
                    Log.w(TAG, "connect 失败: $detail")
                    broadcast(STATE_DISCONNECTED, readable(e))
                    false
                }
                if (!isActive || !wantRun) break
                if (ok) {
                    attempt = 0
                    // 连着：心跳，断了就跳出重连
                    val alive = heartbeatLoop()
                    if (alive) break
                    broadcast(STATE_DISCONNECTED, "连接掉了，正在重连…")
                }
                // 指数退避：3,6,12,24,48,60,60...
                attempt = (attempt + 1).coerceAtMost(10)
                val waitMs = (3000L shl (attempt - 1)).coerceAtMost(60_000L)
                TLog.add("retry", "第 $attempt 次重试，${waitMs}ms 后")
                Log.i(TAG, "第 $attempt 次重试，$waitMs ms 后")
                broadcast(STATE_DISCONNECTED, "${waitMs / 1000} 秒后重试（第 $attempt 次）")
                delay(waitMs)
            }
            Log.i(TAG, "worker 结束")
        }
    }

    /** 建一次连：JSch 连接 + 本地端口转发。成功返回 true */
    private fun connectOnce(): Boolean {
        val host = Prefs.host
        val user = Prefs.user
        val key = Prefs.key
        val port = Prefs.port
        val webPort = Prefs.webPort.takeIf { it > 0 } ?: WEB_PORT_DEFAULT
        // 把实际读到的配置打进日志 —— 连不上时这是第一手证据
        TLog.add(
            "cfg",
            "读到配置 host=[${host}] port=$port user=[${user}] " +
                "keyLen=${key.length} keyHead=[${key.take(27)}] tokenLen=${Prefs.token.length} webPort=$webPort",
        )
        if (host.isBlank() || key.isBlank()) {
            TLog.add("cfg", "致命：服务器或私钥是空的（配置没读到）")
            broadcast(STATE_DISCONNECTED, "还没配置服务器或密钥")
            wantRun = false
            return false
        }

        broadcast(STATE_CONNECTING, "连接 $host …")
        TLog.add("ssh", "开始连接 $user@$host:$port")
        ConnTest.initJsch()
        val jsch = JSch()
        jsch.addIdentity("fishkey", key.toByteArray(), null, null)
        val s = ConnTest.newSession(jsch, user, host, port)
        s.setServerAliveInterval(20_000)
        s.setServerAliveCountMax(3)
        s.connect(15_000)
        TLog.add("ssh", "认证通过")

        // 把远端 127.0.0.1:webPort 转发到本机 127.0.0.1:webPort
        s.setPortForwardingL("127.0.0.1", webPort, "127.0.0.1", webPort)
        TLog.add("ssh", "端口转发就绪 127.0.0.1:$webPort")

        session = s
        attempt = 0
        broadcast(STATE_CONNECTED, "已连接")
        Log.i(TAG, "隧道已建立 → 127.0.0.1:$webPort")
        return true
    }

    /**
     * 心跳：每 15 秒看一次。会话断了或 HTTP 探不通就返回 false（让外层重连）。
     * 连续 3 次 HTTP 失败才算断，避免偶发超时误判。
     */
    private suspend fun heartbeatLoop(): Boolean {
        var httpFail = 0
        while (scope?.isActive == true && wantRun) {
            delay(15_000)
            val s = session
            if (s == null || !s.isConnected) {
                TLog.add("hb", "session 断了")
                Log.i(TAG, "session 断了")
                teardown()
                return false
            }
            val okPort = s.portForwardingL.any { it.contains(":") && it.endsWith(":${Prefs.webPort}") } ||
                s.portForwardingL.isNotEmpty()
            if (!okPort) {
                Log.i(TAG, "端口转发列表空了")
                teardown()
                return false
            }
            if (probeHttp()) {
                httpFail = 0
            } else {
                httpFail++
                if (httpFail >= 3) {
                    TLog.add("hb", "HTTP 探测连续失败 3 次，判定断线")
                    Log.i(TAG, "HTTP 探测连续失败 3 次，判定断线")
                    teardown()
                    return false
                }
            }
        }
        return true
    }

    /** 探一下本地 WebUI 有没有响应（只读，不做破坏） */
    private fun probeHttp(): Boolean {
        var c: HttpURLConnection? = null
        return try {
            val u = URL("http://127.0.0.1:${Prefs.webPort}/manifest.json?token=" + Prefs.token)
            c = (u.openConnection() as HttpURLConnection).apply {
                connectTimeout = 4000
                readTimeout = 4000
                requestMethod = "GET"
            }
            val code = c.responseCode
            code in 200..499
        } catch (e: Exception) {
            false
        } finally {
            try {
                c?.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun teardown() {
        try {
            session?.disconnect()
        } catch (_: Exception) {
        }
        session = null
    }

    private fun broadcast(state: Int, msg: String) {
        lastState = state
        lastMsg = msg
        val i = Intent(BROADCAST_STATE)
        i.setPackage(packageName)
        i.putExtra("state", state)
        i.putExtra("msg", msg)
        sendBroadcast(i)
        updateNotification(state, msg)
    }

    private fun readable(e: Throwable): String = ConnTest.humanize(e)

    // ── 通知 ──

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CH_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW,
            )
            ch.setShowBadge(false)
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .createNotificationChannel(ch)
        }
    }

    private fun startForegroundCompat() {
        startForeground(NOTI_ID, buildNotification(STATE_CONNECTING, "连接中…"))
    }

    private fun stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    private fun updateNotification(state: Int, msg: String) {
        try {
            (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .notify(NOTI_ID, buildNotification(state, msg))
        } catch (_: Exception) {
        }
    }

    private fun buildNotification(state: Int, msg: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val recon = PendingIntent.getService(
            this, 1,
            Intent(this, TunnelService::class.java).setAction(ACTION_RECONNECT),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val title = when (state) {
            STATE_CONNECTED -> "已连接"
            STATE_CONNECTING -> "连接中"
            else -> "断开"
        }
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CH_ID)
        else
            @Suppress("DEPRECATION") Notification.Builder(this)

        return b.setContentTitle(getString(R.string.app_name) + " · " + title)
            .setContentText(msg)
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "重连", recon).build())
            .setOngoing(state != STATE_DISCONNECTED)
            .setOnlyAlertOnce(true)
            .build()
    }

    override fun onDestroy() {
        wantRun = false
        teardown()
        scope?.cancel()
        scope = null
        super.onDestroy()
    }
}
