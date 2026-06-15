import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { SignJWT } from "jose";
import { eq } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import { maquinas, logsServicosWindows } from "../db/schema";
import { config } from "../config";
import { obterSocketAgente } from "../gateway/agent";
import { requireEscopoMaquina } from "../escopo";
import { requirePermissao } from "../permissoes";
import { requirePlano } from "../plano-guard";

const grantSecret = new TextEncoder().encode(config.SCREEN_GRANT_SECRET ?? config.JWT_SECRET);

// https://rmm.gmtec.tec.br/spike -> wss://rmm.gmtec.tec.br/spike/agent
function relayWssAgente(): string {
  return config.TELA_RELAY_URL.replace(/^http/, "ws") + "/agent";
}

export const telaRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /api/maquinas/:id/tela
   * Autoriza o admin (sessão + MFA + tenant), emite um GRANT EFÊMERO (60s) para o
   * viewer, e SINALIZA o agente de produção daquela máquina (pelo canal mTLS) para
   * abrir a tela — entregando senha VNC + token efêmero do relay SEM expô-los no
   * instalador público. Toda abertura é auditada (append-only).
   */
  app.post(
    "/api/maquinas/:id/tela",
    { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requirePermissao("acesso_remoto"), requirePlano("acesso_remoto"), requireEscopoMaquina] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const auth = req.auth!;

      const maquina = await comTenant(auth.tenantId, async (tdb) => {
        const rows = await tdb.select().from(maquinas).where(eq(maquinas.id, id)).limit(1);
        return rows[0];
      });
      if (!maquina) return reply.code(404).send({ erro: "máquina não encontrada" });

      const socket = obterSocketAgente(id);

      // Senha VNC ALEATÓRIA por sessão (8 chars — limite do VNC). Descartável.
      const alfa = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
      let vncPw = "";
      for (let i = 0; i < 8; i++) vncPw += alfa[crypto.randomInt(alfa.length)];

      // 1. Sinaliza o agente PRIMEIRO para que ele inicie o nexus-screen.exe.
      //    Só depois pedimos a lista de monitores, dando tempo ao helper subir.
      let agentePresente = false;
      let agentToken = "";
      if (socket) {
        agentToken = await new SignJWT({ typ: "screen-agent", machineId: id })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(id)
          .setIssuedAt()
          .setExpirationTime("120s")
          .sign(grantSecret);

        socket.emit("server:screen-start", {
          relayUrl: relayWssAgente(),
          agentToken,
          vncPassword: vncPw,
          machineId: id,
          hostname: maquina.hostname,
        });
        agentePresente = true;
      }

      // 2. Pede a lista de monitores — o agente pré-aquece o helper no connect,
      //    então na maioria dos casos já está disponível. Timeout generoso (12s)
      //    para cobrir o caso de primeira conexão do helper.
      let monitores: Array<{ x: number; y: number; w: number; h: number; principal: boolean }> = [];
      if (socket) {
        monitores = await new Promise((resolve) => {
          let done = false;
          const t = setTimeout(() => {
            if (!done) { done = true; resolve([]); }
          }, 12000);
          socket.once("agent:monitors", (data: any) => {
            if (!done) {
              done = true;
              clearTimeout(t);
              resolve(Array.isArray(data?.monitores) ? data.monitores : []);
            }
          });
          socket.emit("server:get-monitors");
        });
      }

      // 3. Grant do VIEWER com a lista de monitores já populada.
      const token = await new SignJWT({
        typ: "screen",
        machineId: id,
        tenantId: auth.tenantId,
        hostname: maquina.hostname,
        monitores,
        vncPw,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(auth.userId)
        .setIssuedAt()
        .setExpirationTime("30m")  // token de tela remota — 30min (viewer reconecta dentro desta janela)
        .sign(grantSecret);

      // Auditoria imutável.
      await comTenant(auth.tenantId, async (tdb) => {
        await tdb.insert(logsServicosWindows).values({
          tenantId: auth.tenantId,
          usuarioId: auth.userId,
          maquinaId: id,
          servicoNome: "TELA",
          acaoExecutada: "ACESSO_NAO_SUPERVISIONADO",
          statusResultado: "INICIADO",
        });
      });

      const viewerUrl = `${config.TELA_RELAY_URL}/viewer?token=${encodeURIComponent(token)}`;
      return reply.send({ viewerUrl, expiraEmSegundos: 1800, hostname: maquina.hostname, agentePresente });
    },
  );
};
