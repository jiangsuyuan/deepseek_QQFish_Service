package io.github.jiangsuyuan.fishtray

import com.jcraft.jsch.JSch
import com.jcraft.jsch.Session

/**
 * 连接测试 + 私钥校验。设置页「测试连接」用它，主流程的错误描述也用它。
 */
object ConnTest {

    /** 校验私钥格式，返回 null 表示没问题，否则返回人话原因 */
    fun validateKey(raw: String): String? {
        val t = raw.trim().replace("\r\n", "\n").replace('\r', '\n')
        if (t.isBlank()) return "私钥是空的"
        if (!t.startsWith("-----BEGIN")) return "私钥开头不对（应形如 -----BEGIN OPENSSH PRIVATE KEY-----）"
        if (!t.trimEnd().endsWith("-----")) return "私钥结尾不对（缺 -----END OPENSSH PRIVATE KEY-----）"
        val hasBegin = t.contains("-----BEGIN OPENSSH PRIVATE KEY-----") ||
            t.contains("-----BEGIN RSA PRIVATE KEY-----")
        val hasEnd = t.contains("-----END OPENSSH PRIVATE KEY-----") ||
            t.contains("-----END RSA PRIVATE KEY-----")
        if (!hasBegin) return "看不出私钥类型（只认 OPENSSH / RSA 两种）"
        if (!hasEnd) return "缺结尾那一行"

        val body = t.lines()
            .filter { it.isNotBlank() && !it.trimStart().startsWith("-----") }
            .joinToString("")
        if (body.length < 80) return "私钥正文太短（可能只复制了一部分）"
        if (!Regex("^[A-Za-z0-9+/=]+$").matches(body)) {
            val bad = body.firstOrNull { !(it.isLetterOrDigit() || it == '+' || it == '/' || it == '=') }
            return "私钥正文里有非法字符「${bad}」——多半是复制时混进了空格或换行"
        }
        return null
    }

    /**
     * 私钥指纹：归一化（统一换行、去首尾空白）后算 SHA-256，取前 16 位。
     * 用来让用户核对「App 里这份」和「电脑上那份」是不是同一把——
     * 只看格式校验不够，坏掉的私钥也可能格式对但内容不一样。
     */
    fun keyFingerprint(raw: String): String {
        if (raw.isBlank()) return ""
        return try {
            val norm = raw.replace("\r\n", "\n").replace('\r', '\n').trim()
            val md = java.security.MessageDigest.getInstance("SHA-256")
            val d = md.digest(norm.toByteArray(Charsets.UTF_8))
            d.joinToString("") { "%02x".format(it) }.take(16)
        } catch (e: Exception) {
            ""
        }
    }

    private var loggerReady = false
    /** 最近一次测试用的私钥类型，humanize 里用来给针对性建议 */
    @Volatile
    var lastKeyType: String = "unknown"

    /** 打开 JSch 内部日志（Android 上出问题时唯一能看到内部步骤的办法） */
    fun initJsch() {
        if (loggerReady) return
        loggerReady = true
        try {
            JSch.setLogger(object : com.jcraft.jsch.Logger {
                override fun isEnabled(level: Int): Boolean = true
                override fun log(level: Int, message: String) {
                    TLog.add("jsch", message)
                }
            })
        } catch (e: Throwable) {
            TLog.add("jsch", "装 logger 失败: " + e.message)
        }
    }

    /**
     * 建 Session。显式指定算法列表——JSch 在 Android 上自动探测会混进
     * gssapi-* 之类，导致 publickey 阶段异常。
     */
    fun newSession(jsch: JSch, user: String, host: String, port: Int): Session {
        val s = jsch.getSession(user, host, port)
        s.setConfig("StrictHostKeyChecking", "no")
        // 只限定走公钥，不碰算法列表（算法列表设错会变成 negotiation fail，
        // 反而盖掉真正的问题）
        s.setConfig("PreferredAuthentications", "publickey")
        s.timeout = 15_000
        return s
    }


    /**
     * 识别私钥类型。Android 上踩过的坑：
     *   OpenSSH 新格式（-----BEGIN OPENSSH PRIVATE KEY-----）的 ed25519，
     *   在 JDK 上 JSch 能正常解析，在 Android 上会静默算错密钥 → 报 Auth fail。
     *   PEM 格式的 RSA（-----BEGIN RSA PRIVATE KEY-----）在两边都稳。
     */
    fun keyType(raw: String): String {
        val t = raw.trim()
        if (t.isEmpty()) return "empty"
        if (t.contains("-----BEGIN RSA PRIVATE KEY-----")) return "rsa-pem"
        if (t.contains("-----BEGIN PRIVATE KEY-----")) return "pkcs8"
        if (!t.contains("-----BEGIN OPENSSH PRIVATE KEY-----")) return "unknown"
        return try {
            val body = t.lines()
                .filter { it.isNotBlank() && !it.trimStart().startsWith("-----") }
                .joinToString("")
            val b = android.util.Base64.decode(body, android.util.Base64.DEFAULT)
            val head = String(b, 0, minOf(b.size, 40), Charsets.US_ASCII)
            when {
                head.contains("ssh-ed25519") -> "ed25519"
                head.contains("ssh-rsa") -> "rsa-openssh"
                head.contains("ecdsa") -> "ecdsa"
                else -> "openssh-unknown"
            }
        } catch (e: Exception) {
            "openssh-unknown"
        }
    }

    /** 非致命提醒：返回建议文案，null 表示这个格式没问题 */
    fun keyWarning(raw: String): String? = when (keyType(raw)) {
        "ed25519" ->
            "⚠️ 这是 ed25519 私钥（OpenSSH 新格式）。实测在安卓上会报「认证失败」——JSch 在 Android 运行时里解析不了它。" +
                "\n建议换成 PEM 格式的 RSA（下方「私钥」说明里有生成命令）。"
        "rsa-openssh" ->
            "⚠️ 这是 OpenSSH 新格式的 RSA。OpenSSH 格式在安卓上有解析风险，PEM 格式更稳。"
        "ecdsa" ->
            "⚠️ ECDSA 私钥在安卓上依赖 BouncyCastle，未必可用。建议换 RSA。"
        else -> null
    }

    /** 推荐的生成命令（设置页显示给用户） */
    const val KEY_HINT_CMD =
        "ssh-keygen -t rsa -b 4096 -m PEM -f id_rsa_android\n" +
            "cat id_rsa_android.pub >> ~/.ssh/authorized_keys"

    data class Result(val ok: Boolean, val text: String)

    /**
     * 真连一次做验证：认证 + 建一条端口转发，然后断开。
     * 阻塞调用，务必放在后台线程。
     */
    fun test(host: String, port: Int, user: String, key: String): Result {
        if (host.isBlank()) return Result(false, "服务器地址是空的")
        if (user.isBlank()) return Result(false, "用户名是空的")
        validateKey(key)?.let { return Result(false, it) }

        val t0 = System.currentTimeMillis()
        var s: Session? = null
        return try {
            TLog.add("test", "开始测试 → $user@$host:$port")
            initJsch()
            lastKeyType = keyType(key)
            TLog.add("test", "私钥类型=" + lastKeyType + " 指纹=" + keyFingerprint(key) + " 长度=" + key.length)
            val jsch = JSch()
            TLog.add("test", "JSch 版本=" + JSch.VERSION + " keyLen=" + key.length)
            jsch.addIdentity("testkey", key.toByteArray(), null, null)
            s = newSession(jsch, user, host, port)
            s.connect(15_000)
            TLog.add("test", "认证通过")

            // 用临时端口试建转发，验证服务器允许转发
            s.setPortForwardingL("127.0.0.1", 39_991, "127.0.0.1", Prefs.webPort)
            TLog.add("test", "端口转发 OK")

            val ms = System.currentTimeMillis() - t0
            Result(true, "连接成功（${ms}ms）\n认证通过，端口转发可用")
        } catch (e: Exception) {
            TLog.add("test", "失败：${TLog.describe(e)}")
            Result(false, "连接失败\n" + humanize(e))
        } finally {
            runCatching { s?.disconnect() }
        }
    }

    /** 把底层异常翻成能看懂的原因 */
    fun humanize(e: Throwable): String {
        val chain = StringBuilder()
        var t: Throwable? = e
        val msgs = ArrayList<String>()
        var depth = 0
        while (t != null && depth < 6) {
            t.message?.let { msgs.add(it) }
            t = t.cause
            depth++
        }
        chain.append(msgs.joinToString(" / "))

        val low = chain.toString().lowercase()
        return when {
            low.contains("auth fail") || low.contains("auth cancel") ->
                if (lastKeyType == "ed25519" || lastKeyType == "rsa-openssh")
                    "认证失败。\n\n**很可能就是私钥格式的问题**：你用的是 OpenSSH 新格式（$lastKeyType），" +
                        "这种格式在安卓上 JSch 解析会出错（同样的私钥在电脑上能连）。\n\n" +
                        "换 PEM 格式的 RSA：\n" +
                        "  ssh-keygen -t rsa -b 4096 -m PEM -f id_rsa_android\n" +
                        "  cat id_rsa_android.pub >> ~/.ssh/authorized_keys\n" +
                        "然后把 id_rsa_android 当文件传到手机，全选复制粘进来。"
                else
                    "认证失败 —— 私钥不对，或者这把公钥没加进服务器的 authorized_keys"

            low.contains("invalid privatekey") || low.contains("invalidkey") ->
                "私钥解析不了 —— 内容被复制坏了（换行/空格混进去了），重新完整复制一次"

            low.contains("userauth fail") ->
                "认证失败 —— 服务器拒绝了这个用户 + 密钥的组合"

            low.contains("timeout") || low.contains("timed out") ->
                "连接超时 —— 地址/端口对不对？服务器的 22 端口通不通？（也可能是你的网络拦了 22 端口）"

            low.contains("connection refused") ->
                "服务器拒绝连接 —— SSH 端口不对，或者服务没开"

            low.contains("unknownhost") || low.contains("nodename") ->
                "找不到这台主机 —— 地址打错了（注意别少字符）"

            low.contains("network is unreachable") || low.contains("no route") ->
                "网络不通 —— 手机现在的网络连不到这个地址"

            low.contains("host key") ->
                "主机密钥校验 —— 这个不该出现，告诉我"

            low.contains("administratively prohibited") || low.contains("forwarding") ->
                "端口转发被服务器禁了 —— 服务器 sshd_config 里 AllowTcpForwarding 可能被关了"

            else -> "原因不明，下面是原始信息：\n" + chain.take(400).ifBlank { e.javaClass.simpleName }
        }
    }
}
