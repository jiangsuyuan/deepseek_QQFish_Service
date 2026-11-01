# jsch 用到反射，别混淆
-keep class com.jcraft.jsch.** { *; }
-keep class org.bouncycastle.** { *; }