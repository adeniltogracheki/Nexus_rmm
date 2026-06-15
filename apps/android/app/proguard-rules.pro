# Add project specific ProGuard rules here.

# Socket.IO client
-keep class io.socket.** { *; }
-keep class io.socket.client.** { *; }
-keep class io.socket.engineio.** { *; }
-keep class com.google.gson.** { *; }
-keep class org.json.** { *; }

# OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keep class okhttp3.** { *; }
-keep class okio.** { *; }

# Kotlin coroutines
-keepnames class kotlinx.coroutines.internal.MainDispatcherFactory {}
-keepnames class kotlinx.coroutines.CoroutineExceptionHandler {}

# Nexus RMM agent classes
-keep class br.com.nexusrmm.agent.** { *; }
