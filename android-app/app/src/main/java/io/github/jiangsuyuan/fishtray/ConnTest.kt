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
            val jsch = JSch()
            jsch.addIdentity("testkey", key.toByteArray(), null, null)
            s = jsch.getSession(user, host, port)
            s.setConfig("StrictHostKeyChecking", "no")
            s.timeout = 15_000
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
