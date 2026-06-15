import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { comTenant } from "../db/tenant";
import { maquinas, logsServicosWindows } from "../db/schema";
import { obterOuCriarCa } from "../pki/ca";
import { enviarComandoAgente } from "../gateway/agent";
import { obterPayloadAssinatura } from "@nexus/protocol";
import { requireEscopoMaquina } from "../escopo";
import { requirePermissao } from "../permissoes";
import { requirePlano } from "../plano-guard";

async function disparar(machineId: string, base: Record<string, unknown>) {
  const { caKeyPem } = obterOuCriarCa();
  const commandId = crypto.randomUUID();
  const issuedAt = Date.now();
  const payload = { commandId, machineId, issuedAt, expiresAt: issuedAt + 120_000, ...base };
  const canonical = obterPayloadAssinatura(payload as never);
  const sign = crypto.createSign("SHA256");
  sign.update(canonical);
  const signature = sign.sign(caKeyPem, "hex");
  return enviarComandoAgente(machineId, { ...payload, signature } as never);
}

export const arquivosRoutes: FastifyPluginAsync = async (app) => {
  async function checaMaquina(tenantId: string, id: string): Promise<boolean> {
    return comTenant(tenantId, async (tdb) => {
      const r = await tdb.select({ id: maquinas.id }).from(maquinas).where(eq(maquinas.id, id)).limit(1);
      return r.length > 0;
    });
  }

  // GET /api/maquinas/:id/arquivos?path=... — lista pasta (ou drives se path vazio).
  app.get("/api/maquinas/:id/arquivos", { preHandler: [app.requireAuth, app.requireOperador, requirePermissao("arquivos"), requirePlano("arquivos"), requireEscopoMaquina] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId } = req.auth!;
    const caminho = ((req.query as { path?: string })?.path || "").trim();
    if (!(await checaMaquina(tenantId, id))) return reply.code(404).send({ erro: "máquina não encontrada" });
    const esc = caminho.replace(/'/g, "''");
    const cmd = !caminho
      ? "Get-PSDrive -PSProvider FileSystem | Select-Object @{N='Name';E={$_.Name+':\\'}}, @{N='dir';E={$true}}, @{N='tamanho';E={0}} | ConvertTo-Json -Compress"
      : `$p='${esc}'; Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue | Select-Object Name, @{N='dir';E={$_.PSIsContainer}}, @{N='tamanho';E={if($_.PSIsContainer){0}else{$_.Length}}}, @{N='modificado';E={$_.LastWriteTime.ToString('o')}} | ConvertTo-Json -Compress`;
    try {
      const r = await disparar(id, { type: "shell.run", shell: "powershell", command: cmd });
      if (r.status === "FALHA") return reply.code(502).send({ erro: r.error || "falha no agente" });
      let itens: unknown = [];
      try {
        const parsed = JSON.parse(((r as { output?: string }).output || "[]").trim() || "[]");
        itens = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        itens = [];
      }
      return reply.send({ caminho, itens });
    } catch (err) {
      app.log.error({ err, id }, "Erro ao listar arquivos");
      return reply.code(502).send({ erro: "máquina offline ou sem resposta" });
    }
  });

  // GET /api/maquinas/:id/arquivo?path=... — baixa um arquivo (até 10MB).
  app.get("/api/maquinas/:id/arquivo", { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requirePermissao("arquivos"), requirePlano("arquivos"), requireEscopoMaquina] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId, userId } = req.auth!;
    const caminho = ((req.query as { path?: string })?.path || "").trim();
    if (!caminho) return reply.code(400).send({ erro: "informe o caminho" });
    if (!(await checaMaquina(tenantId, id))) return reply.code(404).send({ erro: "máquina não encontrada" });
    try {
      const r = await disparar(id, { type: "file.read", path: caminho });
      await comTenant(tenantId, (tdb) =>
        tdb.insert(logsServicosWindows).values({
          tenantId, usuarioId: userId, maquinaId: id, servicoNome: "ARQUIVO",
          acaoExecutada: `Baixar: ${caminho.slice(0, 380)}`,
          statusResultado: r.status === "FALHA" ? "FALHA" : "SUCESSO",
          detalhesErro: r.error || null,
        }),
      );
      if (r.status === "FALHA") return reply.code(502).send({ erro: r.error || "falha ao ler arquivo" });
      const buf = Buffer.from((r as { output?: string }).output || "", "base64");
      const nome = caminho.split(/[\\/]/).pop() || "arquivo";
      reply.header("Content-Disposition", `attachment; filename="${nome.replace(/"/g, "")}"`);
      reply.type("application/octet-stream");
      return reply.send(buf);
    } catch (err) {
      app.log.error({ err, id }, "Erro ao baixar arquivo");
      return reply.code(502).send({ erro: "máquina offline ou sem resposta" });
    }
  });

  // POST /api/maquinas/:id/arquivo — envia um arquivo (base64) para um caminho.
  app.post("/api/maquinas/:id/arquivo", { preHandler: [app.requireAuth, app.requireMfa, app.requireOperador, requirePermissao("arquivos"), requirePlano("arquivos"), requireEscopoMaquina] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { tenantId, userId } = req.auth!;
    const p = z.object({ path: z.string().min(1).max(4000), conteudo: z.string().min(1) }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ erro: "dados inválidos" });
    if (!(await checaMaquina(tenantId, id))) return reply.code(404).send({ erro: "máquina não encontrada" });
    try {
      const r = await disparar(id, { type: "file.write", path: p.data.path, conteudo: p.data.conteudo });
      await comTenant(tenantId, (tdb) =>
        tdb.insert(logsServicosWindows).values({
          tenantId, usuarioId: userId, maquinaId: id, servicoNome: "ARQUIVO",
          acaoExecutada: `Enviar: ${p.data.path.slice(0, 380)}`,
          statusResultado: r.status === "FALHA" ? "FALHA" : "SUCESSO",
          detalhesErro: r.error || null,
        }),
      );
      if (r.status === "FALHA") return reply.code(502).send({ erro: r.error || "falha ao gravar" });
      return reply.send({ ok: true, msg: (r as { output?: string }).output || "Enviado." });
    } catch (err) {
      app.log.error({ err, id }, "Erro ao enviar arquivo");
      return reply.code(502).send({ erro: "máquina offline ou sem resposta" });
    }
  });
};
