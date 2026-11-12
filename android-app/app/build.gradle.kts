plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.jiangsuyuan.fishtray"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.jiangsuyuan.fishtray"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1-dashboard"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = false
    }
    // 只保留需要的 ABI，减小体积
    packaging {
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // mwiede 维护的 jsch fork：支持 ed25519 / curve25519 / chacha20
    implementation("com.github.mwiede:jsch:0.2.20")
    implementation("androidx.webkit:webkit:1.11.0")
}
