import dgram from "node:dgram";
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import { maquinas } from "../db/schema";
import { requireEscopoMaquina } from "../escopo";
import { requirePermissao } from "../permissoes";
import { obterSocketAgente } from "../gateway/agent";

/** Monta e envia magic packet Wake-on-LAN localmente (mesmo servidor) via UDP broadcast. */
function enviarMagicPacketLocal(mac: string): void {
  const macBytes = mac.replace(/[:\-]/g, "").match(/.{2}/g)!.map((b) => parseInt(b, 16));
  const pkt = Buffer.alloc(102);
  pkt.fill(0xff, 0, 6);
  for (let i = 0; i < 16; i++) Buffer.from(macBytes).copy(pkt, 6 + i * 6);

  const sock = dgram.createSocket("udp4");
  sock.bind(() => {
    sock.setBroadcast(true);
    // Porta 9 (discard) é a padrão do WoL; porta 7 também funciona
    sock.send(pkt, 0, pkt.length, 9, "255.255.255.255", () => sock.close());
  });
}

export const wolRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/maquinas/:id/wol
   *
   * Envia um magic packet Wake-on-LAN para a máquina alvo.
   * Estratégia em cascata:
   *   1. Se houver um agente online na mesma rede (mesmo ip_publico) → delega ao peer via Socket.io
   *   2. Se não houver peer → tenta enviar direto do servidor (funciona apenas se estiver na mesma LAN)
   */
  app.post(
    "/api/maquinas/:id/wol",
    {
      preHandler: [
        app.requireAuth,
        app.requireOperador,
        requirePermissao("acesso_remoto"),
        requireEscopoMaquina,
      ],
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId } = req.auth!;

      // Carrega a máquina alvo
      const alvo = await comTenant(tenantId, async (tdb) => {
        const rows = await tdb.select().from(maquinas).where(eq(maquinas.id, id)).limit(1);
        return rows[0] ?? null;
      });

      if (!alvo) return reply.code(404).send({ erro: "Máquina não encontrada" });
      if (!alvo.macAddress) {
        return reply.code(422).send({
          erro: "MAC address não disponível. Aguarde o agente reportar o inventário.",
        });
      }

      const mac = alvo.macAddress;

      // Tenta encontrar peer online na mesma rede (ip_publico idêntico)
      let peerEnviou = false;
      if (alvo.ipPublico) {
        // Busca todas as máquinas do tenant com mesmo IP público e que estejam online
        const peers = await comTenant(tenantId, async (tdb) => {
          return tdb
            .select({ id: maquinas.id })
            .from(maquinas)
            .where(eq(maquinas.ipPublico, alvo.ipPublico!));
        });

        for (const peer of peers) {
          if (peer.id === id) continue; // não tenta a própria máquina (está offline)
          const peerSocket = obterSocketAgente(peer.id);
          if (peerSocket) {
            peerSocket.emit("server:wol", { targetMac: mac });
            peerEnviou = true;
            app.log.info({ machineId: id, peerId: peer.id, mac }, "WoL delegado ao peer");
            break;
          }
        }
      }

      if (!peerEnviou) {
        // Fallback: envia direto do servidor (funciona se o servidor estiver na mesma LAN)
        try {
          enviarMagicPacketLocal(mac);
          app.log.info({ machineId: id, mac }, "WoL enviado direto do servidor (sem peer disponível)");
        } catch (err) {
          app.log.warn({ err, machineId: id }, "Falha ao enviar magic packet do servidor");
          return reply.code(503).send({
            erro: "Nenhum agente disponível na mesma rede para retransmitir o WoL.",
            detalhe: "Certifique-se de que outra máquina gerenciada esteja online na mesma rede.",
          });
        }
      }

      return reply.send({
        ok: true,
        via: peerEnviou ? "peer" : "servidor",
        mac,
        mensagem: peerEnviou
          ? "Magic packet enviado via agente peer na mesma rede."
          : "Magic packet enviado direto do servidor (fallback).",
      });
    },
  );
};
