pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // mwiede 的 jsch fork 不在 mavenCentral 的默认坐标下
        maven { url = uri("https://jitpack.io") }
    }
}
rootProject.name = "FishTrayAndroid"
include(":app")
