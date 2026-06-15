# Nexus RMM — Agente Android

APK nativo Kotlin para dispositivos Android 8.0+ (API 26+). Sem root.

## Funcionalidades

| Recurso | Como funciona |
|---------|---------------|
| Inventário | Android APIs (hardware, SO, apps, rede) |
| Métricas | RAM em tempo real via ActivityManager |
| Terminal | ProcessBuilder("/system/bin/sh") |
| Tela remota | MediaProjection + relay WebSocket (mesmo protocolo Windows/macOS) |
| Controle remoto | AccessibilityService (toque, scroll, teclas) |
| Conexão | Socket.io mTLS — mesmo gateway dos outros agentes |
| Auto-start | BroadcastReceiver BOOT_COMPLETED |

## Pré-requisitos de build

- Android Studio Iguana (2023.2.1) ou superior **ou** JDK 17 + Android SDK command-line tools
- `ANDROID_HOME` configurado (geralmente `~/Android/Sdk`)

## Build via Android Studio

1. Abra a pasta `apps/android/` como projeto
2. Aguarde o Gradle sync
3. **Build → Generate Signed APK/Bundle** → APK
4. Keystore: crie um novo ou use o existente em `apps/android/keystore/` (não commitar!)

## Build via linha de comando

```bash
cd apps/android

# Debug APK (para testes)
./gradlew assembleDebug
# Saída: app/build/outputs/apk/debug/app-debug.apk

# Release APK (assinar depois)
./gradlew assembleRelease
# Saída: app/build/outputs/apk/release/app-release-unsigned.apk

# Assinar o release APK
jarsigner -verbose -sigalg SHA256withRSA -digestalg SHA-256 \
  -keystore /path/to/keystore.jks \
  app/build/outputs/apk/release/app-release-unsigned.apk alias_name

zipalign -v 4 \
  app/build/outputs/apk/release/app-release-unsigned.apk \
  app/build/outputs/apk/release/nexus-rmm-agent.apk
```

## Publicar o APK no servidor web

```bash
scp app/build/outputs/apk/release/nexus-rmm-agent.apk \
    opc@rmm.gmtec.tec.br:/opt/nexus-rmm/public/nexus-rmm-agent.apk
```

O painel serve o arquivo em `https://rmm.gmtec.tec.br/nexus-rmm-agent.apk`.

## Instalação no dispositivo

1. Habilite **Instalar apps desconhecidos** nas configurações do Android
2. Transfira o APK para o dispositivo e instale
3. Abra o app **Nexus RMM Agent**
4. Informe a URL do servidor (ex: `https://rmm.gmtec.tec.br`) e o token de cadastro gerado no painel
5. Toque em **Cadastrar** — o agente gera par de chaves RSA e registra no servidor
6. Vá em Configurações → Acessibilidade → **Nexus RMM Control** e ative (necessário para controle remoto)
7. Quando o painel solicitar tela remota, o Android exibirá um diálogo de permissão — aprove

## Permissões necessárias

| Permissão | Quando |
|-----------|--------|
| INTERNET | Sempre |
| FOREGROUND_SERVICE | Sempre |
| POST_NOTIFICATIONS | Android 13+ (notificação de status) |
| RECEIVE_BOOT_COMPLETED | Auto-start após reboot |
| AccessibilityService | Controle remoto (toque/teclado) — habilitado manualmente |
| MediaProjection | Tela remota — diálogo de permissão por sessão |

## Versão

`0.7.0-android` — compatível com gateway Nexus RMM `>=0.5.0`
