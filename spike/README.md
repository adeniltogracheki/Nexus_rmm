# Spike da Tela em Tempo Real (descartável)

PoC para de-riscar a feature-âncora: ver o desktop de uma máquina Windows **ao vivo,
não supervisionado, no navegador, com controle** — trafegando **só outbound e cifrado**.

```
Windows PC                         Servidor Linux                  Admin (navegador)
TightVNC(127.0.0.1:5900) ◀── spike/agent ──WSS/TLS──▶ spike/relay ◀──WSS/TLS── noVNC
   (loopback, senha)        (outbound, sem porta)     (Traefik + bridge)     login+tela+controle
```

## Por que é seguro (não interceptável)
O VNC fica **só no loopback** da máquina Windows. Na rede, tudo viaja dentro de **WSS (TLS)**
pelo Traefik — mesmo princípio de "VNC sobre SSH". Reforços: senha no VNC, token no túnel
do agente, login no navegador.

## Endpoint
`https://sis.gmtec.tec.br/spike/` (rota de caminho no Traefik, cert Let's Encrypt existente).

## Operação

### Servidor (relay) — já sobe no deploy
```bash
cd spike
docker compose --env-file .env up -d --build   # usa TRAEFIK_NET, tokens do .env
```

### Máquina Windows (cobaia)
1. TightVNC instalado em modo serviço, **bind 127.0.0.1**, com senha (ver scripts/).
2. Rodar o agente (uma vez):
   ```powershell
   cd spike\agent
   npm install
   $env:SPIKE_RELAY_URL  = "wss://sis.gmtec.tec.br/spike/agent"
   $env:SPIKE_AGENT_TOKEN = "<mesmo token do .env do relay>"
   npm start
   ```

### Ver a tela
Abra `https://sis.gmtec.tec.br/spike/`, digite a senha de acesso → a tela aparece ao vivo,
e você controla mouse/teclado.

## Variáveis (`spike/.env`, fora do git)
- `SPIKE_AGENT_TOKEN` — segredo compartilhado relay↔agente.
- `SPIKE_VIEW_PASSWORD` — senha de acesso ao viewer.
- `TRAEFIK_NET` — nome da rede docker do Traefik.

> Descartável: o que reaproveitamos é o padrão túnel-reverso-outbound + relay + viewer.
> A captura de tela "de verdade" (DXGI/WebRTC ou VNC bundle) é decisão da fase de produção.
