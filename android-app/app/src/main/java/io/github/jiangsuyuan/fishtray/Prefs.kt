package io.github.jiangsuyuan.fishtray

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * 配置存储：服务器 / 用户名 / 私钥 / WebUI token。
 * 私钥和 token 属于敏感信息，用 EncryptedSharedPreferences（密钥交给 Android Keystore）。
 */
object Prefs {
    private const val FILE = "fish_tray_secure"
    private var cached: SharedPreferences? = null

    @Synchronized
    fun sp(ctx: Context): SharedPreferences {
        cached?.let { return it }
        val master = MasterKey.Builder(ctx)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val p = EncryptedSharedPreferences.create(
            ctx,
            FILE,
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        cached = p
        return p
    }

    var host: String
        get() = cachedOrNull()?.getString("host", "") ?: ""
        set(v) = sp(AppCtx.get()).edit().putString("host", v.trim()).apply()

    var port: Int
        get() = cachedOrNull()?.getInt("port", 22) ?: 22
        set(v) = sp(AppCtx.get()).edit().putInt("port", v).apply()

    var user: String
        get() = cachedOrNull()?.getString("user", "root") ?: "root"
        set(v) = sp(AppCtx.get()).edit().putString("user", v.trim()).apply()

    var key: String
        get() = cachedOrNull()?.getString("key", "") ?: ""
        set(v) = sp(AppCtx.get()).edit().putString("key", v.trim()).apply()

    var token: String
        get() = cachedOrNull()?.getString("token", "") ?: ""
        set(v) = sp(AppCtx.get()).edit().putString("token", v.trim()).apply()

    var webPort: Int
        get() = cachedOrNull()?.getInt("webPort", 3081) ?: 3081
        set(v) = sp(AppCtx.get()).edit().putInt("webPort", v).apply()

    fun isConfigured(): Boolean {
        return host.isNotBlank() && user.isNotBlank() && key.isNotBlank() && token.isNotBlank()
    }

    fun webUrl(): String {
        return "http://127.0.0.1:${webPort}/?token=" + android.net.Uri.encode(token)
    }

    private fun cachedOrNull(): SharedPreferences? = cached
}

/** 给 Prefs 在任意地方取 Context 用（Application 里初始化） */
object AppCtx {
    private var ctx: Context? = null
    fun init(c: Context) {
        ctx = c.applicationContext
    }
    fun get(): Context = ctx ?: throw IllegalStateException("AppCtx 未初始化")
}
