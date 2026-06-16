import type { FastifyPluginAsync } from "fastify";
import { eq, and, desc, like, sql, asc, gte, isNull } from "drizzle-orm";
import { comTenant } from "../db/tenant";
import { maquinas, grupos, logsServicosWindows, usuarios, inventarios, presencaLog } from "../db/schema";

export const relatoriosRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/maquinas/:id/logs
  // Retorna o histórico de auditoria de comandos em serviços do Windows executados na máquina
  app.get(
    "/api/maquinas/:id/logs",
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { tenantId } = req.auth!;
      const { status, servico } = req.query as { status?: string; servico?: string };

      try {
        const logs = await comTenant(tenantId, async (tdb) => {
          // Verifica se a máquina existe no tenant (RLS garante)
          const m = await tdb
            .select()
            .from(maquinas)
            .where(eq(maquinas.id, id))
            .limit(1);

          if (m.length === 0) {
            return null;
          }

          const condicoes = [eq(logsServicosWindows.maquinaId, id)];

          if (status) {
            condicoes.push(eq(logsServicosWindows.statusResultado, status));
          }

          if (servico) {
            // Busca case-insensitive aproximada
            condicoes.push(like(sql`lower(${logsServicosWindows.servicoNome})`, `%${servico.toLowerCase()}%`));
          }

          return tdb
            .select({
              id: logsServicosWindows.id,
              usuarioEmail: usuarios.email,
              maquinaId: logsServicosWindows.maquinaId,
              servicoNome: logsServicosWindows.servicoNome,
              acaoExecutada: logsServicosWindows.acaoExecutada,
              tipoInicializacaoAnterior: logsServicosWindows.tipoInicializacaoAnterior,
              statusResultado: logsServicosWindows.statusResultado,
              detalhesErro: logsServicosWindows.detalhesErro,
              hashAnterior: logsServicosWindows.hashAnterior,
              hashRegistro: logsServicosWindows.hashRegistro,
              executadoEm: logsServicosWindows.executadoEm,
            })
            .from(logsServicosWindows)
            .leftJoin(usuarios, eq(logsServicosWindows.usuarioId, usuarios.id))
            .where(and(...condicoes))
            .orderBy(desc(logsServicosWindows.executadoEm));
        });

        if (logs === null) {
          return reply.code(404).send({ erro: "Máquina não encontrada ou sem acesso" });
        }

        return reply.send(logs);
      } catch (err) {
        app.log.error({ err, tenantId, machineId: id }, "Erro ao listar logs da máquina");
        return reply.code(500).send({ erro: "Erro interno ao listar logs" });
      }
    }
  );

  // GET /api/relatorios/resumo
  // Retorna métricas consolidadas do tenant
  app.get(
    "/api/relatorios/resumo",
    { preHandler: [app.requireAuth] },
    async (req, reply) => {
      const { tenantId } = req.auth!;

      try {
        const resumo = await comTenant(tenantId, async (tdb) => {
          // 1. Busca todas as máquinas do tenant (com RLS ativado)
          const todasMaquinas = await tdb.select().from(maquinas);
          const totalMaquinas = todasMaquinas.length;
          const online = todasMaquinas.filter((m) => m.online).length;
          const offline = totalMaquinas - online;
          const pcs = todasMaquinas.filter((m) => m.tipoMaquina === "pc").length;
          const servidores = todasMaquinas.filter((m) => m.tipoMaquina === "servidor").length;

          // 2. Busca grupos e distribui as máquinas
          const todosGrupos = await tdb.select().from(grupos);
          const gruposDistribuicao = todosGrupos.map((g) => {
            const quantidade = todasMaquinas.filter((m) => m.grupoId === g.id).length;
            return {
              grupoId: g.id,
              nome: g.nome,
              tipo: g.tipo,
              quantidade,
            };
          });

          // Quantidade de máquinas sem nenhum grupo associado
          const semGrupoQuantidade = todasMaquinas.filter((m) => !m.grupoId).length;
          gruposDistribuicao.push({
            grupoId: "null",
            nome: "Sem grupo",
            tipo: "empresa", // Default fallback
            quantidade: semGrupoQuantidade,
          });

          // 3. Últimos 10 comandos de auditoria no tenant
          const ultimasAcoes = await tdb
            .select({
              id: logsServicosWindows.id,
              usuarioEmail: usuarios.email,
              maquinaId: logsServicosWindows.maquinaId,
              maquinaHostname: maquinas.hostname,
              maquinaApelido: maquinas.apelido,
              servicoNome: logsServicosWindows.servicoNome,
              acaoExecutada: logsServicosWindows.acaoExecutada,
              statusResultado: logsServicosWindows.statusResultado,
              executadoEm: logsServicosWindows.executadoEm,
            })
            .from(logsServicosWindows)
            .leftJoin(usuarios, eq(logsServicosWindows.usuarioId, usuarios.id))
            .leftJoin(maquinas, eq(logsServicosWindows.maquinaId, maquinas.id))
            .orderBy(desc(logsServicosWindows.executadoEm))
            .limit(10);

          // 4. Volume de ações executadas nos últimos 7 dias (agrupado em memória por dia)
          const dataLimite = new Date();
          dataLimite.setDate(dataLimite.getDate() - 7);
          dataLimite.setHours(0, 0, 0, 0);

          const logsRecentes = await tdb
            .select({
              executadoEm: logsServicosWindows.executadoEm,
            })
            .from(logsServicosWindows)
            .where(sql`${logsServicosWindows.executadoEm} >= ${dataLimite}`);

          const atividadeUltimos7Dias: Array<{ data: string; quantidade: number }> = [];
          for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dataStr = d.toISOString().split("T")[0]!;

            const quantidade = logsRecentes.filter((log) => {
              const logDataStr = new Date(log.executadoEm).toISOString().split("T")[0]!;
              return logDataStr === dataStr;
            }).length;

            atividadeUltimos7Dias.push({
              data: dataStr,
              quantidade,
            });
          }

          return {
            maquinas: {
              total: totalMaquinas,
              online,
              offline,
              pcs,
              servidores,
            },
            grupos: gruposDistribuicao,
            atividadeUltimos7Dias,
            ultimasAcoes,
          };
        });

        return reply.send(resumo);
      } catch (err) {
        app.log.error({ err, tenantId }, "Erro ao gerar resumo de relatórios");
        return reply.code(500).send({ erro: "Erro interno ao gerar resumo de relatórios" });
      }
    }
  );

  // GET /api/relatorios/auditoria — rastreabilidade: todas as ações, filtrável.
  // filtros: de, ate (ISO), maquinaId, status (SUCESSO|FALHA|INICIADO), q (busca), pagina, limite
  app.get("/api/relatorios/auditoria", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!(req.auth!.papel === "owner" || req.auth!.papel === "admin" ||
      (req.auth!.permissoes || []).includes("relatorios"))) {
      return reply.code(403).send({ erro: "sem permissão" });
    }
    const { tenantId } = req.auth!;
    const q = req.query as { de?: string; ate?: string; maquinaId?: string; status?: string; q?: string; pagina?: string; limite?: string };
    const limite = Math.min(200, Math.max(10, Number(q.limite) || 50));
    const pagina = Math.max(0, Number(q.pagina) || 0);
    try {
      const dados = await comTenant(tenantId, async (tdb) => {
        const cond = [] as any[];
        if (q.de) cond.push(sql`${logsServicosWindows.executadoEm} >= ${new Date(q.de)}`);
        if (q.ate) cond.push(sql`${logsServicosWindows.executadoEm} <= ${new Date(q.ate)}`);
        if (q.maquinaId) cond.push(eq(logsServicosWindows.maquinaId, q.maquinaId));
        if (q.status) cond.push(eq(logsServicosWindows.statusResultado, q.status));
        if (q.q) cond.push(sql`(${logsServicosWindows.servicoNome} ILIKE ${"%" + q.q + "%"} OR ${logsServicosWindows.acaoExecutada} ILIKE ${"%" + q.q + "%"})`);
        const where = cond.length ? and(...cond) : undefined;

        const totalRow = await tdb.select({ n: sql<number>`count(*)::int` }).from(logsServicosWindows).where(where as any);
        const itens = await tdb
          .select({
            id: logsServicosWindows.id,
            em: logsServicosWindows.executadoEm,
            usuario: usuarios.email,
            maquinaId: logsServicosWindows.maquinaId,
            hostname: maquinas.hostname,
            apelido: maquinas.apelido,
            tipo: logsServicosWindows.servicoNome,
            acao: logsServicosWindows.acaoExecutada,
            status: logsServicosWindows.statusResultado,
            detalhe: logsServicosWindows.detalhesErro,
          })
          .from(logsServicosWindows)
          .leftJoin(usuarios, eq(logsServicosWindows.usuarioId, usuarios.id))
          .leftJoin(maquinas, eq(logsServicosWindows.maquinaId, maquinas.id))
          .where(where as any)
          .orderBy(desc(logsServicosWindows.executadoEm))
          .limit(limite)
          .offset(pagina * limite);
        return { total: totalRow[0]?.n || 0, itens };
      });
      return reply.send({ ...dados, pagina, limite });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro na auditoria");
      return reply.code(500).send({ erro: "erro ao gerar auditoria" });
    }
  });

  // GET /api/relatorios/inventario — inventário consolidado de toda a frota (último por máquina).
  app.get("/api/relatorios/inventario", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!(req.auth!.papel === "owner" || req.auth!.papel === "admin" ||
      (req.auth!.permissoes || []).includes("inventario") || (req.auth!.permissoes || []).includes("relatorios"))) {
      return reply.code(403).send({ erro: "sem permissão" });
    }
    const { tenantId } = req.auth!;
    try {
      const itens = await comTenant(tenantId, async (tdb) => {
        const mq = await tdb.select().from(maquinas).where(eq(maquinas.arquivada, false));
        const invs = await tdb
          .select({ maquinaId: inventarios.maquinaId, hardware: inventarios.hardware, so: inventarios.so, rede: inventarios.rede, software: inventarios.software, em: inventarios.atualizadoEm })
          .from(inventarios)
          .orderBy(desc(inventarios.atualizadoEm));
        const ultimo = new Map<string, any>();
        for (const i of invs) if (!ultimo.has(i.maquinaId)) ultimo.set(i.maquinaId, i);
        return mq.map((m) => {
          const inv = ultimo.get(m.id);
          const hw = (inv?.hardware || {}) as any;
          const discos = Array.isArray(hw.discos) ? hw.discos : [];
          const totBytes = discos.reduce((s: number, d: any) => s + Number(d.tamanhoBytes || d.Size || 0), 0);
          const livreBytes = discos.reduce((s: number, d: any) => s + Number(d.livreBytes || d.FreeSpace || 0), 0);
          const sw = Array.isArray(inv?.software) ? inv.software.length : 0;
          return {
            id: m.id,
            hostname: m.hostname,
            apelido: m.apelido,
            online: m.online,
            tipo: m.tipoMaquina,
            so: (inv?.so as any)?.nome ? `${(inv!.so as any).nome} ${(inv!.so as any).versao || ""}`.trim() : null,
            cpu: hw.cpu?.modelo || null,
            ramGB: hw.ram?.totalBytes ? +(Number(hw.ram.totalBytes) / 1e9).toFixed(1) : null,
            discoTotalGB: totBytes ? Math.round(totBytes / 1e9) : null,
            discoLivreGB: livreBytes ? Math.round(livreBytes / 1e9) : null,
            softwares: sw,
            atualizadoEm: inv?.em || null,
          };
        });
      });
      return reply.send({ itens });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro no inventário consolidado");
      return reply.code(500).send({ erro: "erro ao gerar inventário" });
    }
  });

  // GET /api/relatorios/uptime?dias=30 — disponibilidade (SLA) por máquina, a partir do log de presença.
  app.get("/api/relatorios/uptime", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!(req.auth!.papel === "owner" || req.auth!.papel === "admin" || (req.auth!.permissoes || []).includes("relatorios"))) {
      return reply.code(403).send({ erro: "sem permissão" });
    }
    const { tenantId } = req.auth!;
    const dias = Math.min(180, Math.max(1, Number((req.query as { dias?: string })?.dias) || 30));
    const desde = new Date(Date.now() - dias * 86400000);
    const agora = Date.now();
    try {
      const r = await comTenant(tenantId, async (tdb) => {
        const mq = await tdb.select().from(maquinas).where(eq(maquinas.arquivada, false));
        const eventos = await tdb
          .select({ maquinaId: presencaLog.maquinaId, online: presencaLog.online, em: presencaLog.em })
          .from(presencaLog)
          .where(gte(presencaLog.em, desde))
          .orderBy(asc(presencaLog.em));
        const porMaquina = new Map<string, Array<{ online: boolean; em: number }>>();
        for (const e of eventos) {
          if (!porMaquina.has(e.maquinaId)) porMaquina.set(e.maquinaId, []);
          porMaquina.get(e.maquinaId)!.push({ online: e.online, em: new Date(e.em).getTime() });
        }
        return mq.map((m) => {
          const evs = porMaquina.get(m.id) || [];
          if (evs.length === 0) return { id: m.id, hostname: m.hostname, apelido: m.apelido, online: m.online, uptime: null as number | null, desde: null as string | null };
          let cursor = evs[0]!.em, estado = evs[0]!.online, onlineMs = 0;
          for (let i = 1; i < evs.length; i++) {
            if (estado) onlineMs += evs[i]!.em - cursor;
            cursor = evs[i]!.em; estado = evs[i]!.online;
          }
          if (estado) onlineMs += agora - cursor;
          const janelaMs = agora - evs[0]!.em;
          const uptime = janelaMs > 0 ? Math.round((onlineMs / janelaMs) * 1000) / 10 : (m.online ? 100 : 0);
          return { id: m.id, hostname: m.hostname, apelido: m.apelido, online: m.online, uptime, desde: new Date(evs[0]!.em).toISOString() };
        });
      });
      return reply.send({ dias, itens: r });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro no uptime");
      return reply.code(500).send({ erro: "erro ao calcular uptime" });
    }
  });

  // GET /api/relatorios/frota — visão geral da frota com filtros completos.
  // filtros: grupoId, tipoMaquina, online (true|false), so, criticidade, responsavel, semGrupo (true), q
  app.get("/api/relatorios/frota", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!(req.auth!.papel === "owner" || req.auth!.papel === "admin" ||
      (req.auth!.permissoes || []).includes("relatorios") || (req.auth!.permissoes || []).includes("ver_maquinas"))) {
      return reply.code(403).send({ erro: "sem permissão" });
    }
    const { tenantId } = req.auth!;
    const q = req.query as { grupoId?: string; tipoMaquina?: string; online?: string; so?: string; criticidade?: string; responsavel?: string; semGrupo?: string; q?: string };
    try {
      const itens = await comTenant(tenantId, async (tdb) => {
        const cond: any[] = [eq(maquinas.arquivada, false)];
        if (q.grupoId) cond.push(eq(maquinas.grupoId, q.grupoId));
        if (q.tipoMaquina) cond.push(eq(maquinas.tipoMaquina, q.tipoMaquina as any));
        if (q.online === "true") cond.push(eq(maquinas.online, true));
        if (q.online === "false") cond.push(eq(maquinas.online, false));
        if (q.criticidade) cond.push(eq(maquinas.criticidade, q.criticidade));
        if (q.responsavel) cond.push(sql`${maquinas.responsavel} ILIKE ${"%" + q.responsavel + "%"}`);
        if (q.semGrupo === "true") cond.push(isNull(maquinas.grupoId));
        if (q.so) cond.push(sql`${maquinas.soVersao} ILIKE ${"%" + q.so + "%"}`);
        if (q.q) cond.push(sql`(${maquinas.hostname} ILIKE ${"%" + q.q + "%"} OR ${maquinas.apelido} ILIKE ${"%" + q.q + "%"})`);

        const mqs = await tdb
          .select({
            id: maquinas.id,
            hostname: maquinas.hostname,
            apelido: maquinas.apelido,
            grupoId: maquinas.grupoId,
            tipoMaquina: maquinas.tipoMaquina,
            online: maquinas.online,
            soVersao: maquinas.soVersao,
            versaoAgente: maquinas.versaoAgente,
            criticidade: maquinas.criticidade,
            responsavel: maquinas.responsavel,
            vistoEm: maquinas.vistoEm,
          })
          .from(maquinas)
          .where(and(...cond))
          .orderBy(asc(maquinas.hostname));

        const todosGrupos = await tdb.select({ id: grupos.id, nome: grupos.nome }).from(grupos);
        const grupoMap = new Map(todosGrupos.map((g) => [g.id, g.nome]));

        const invs = await tdb
          .select({ maquinaId: inventarios.maquinaId, hardware: inventarios.hardware })
          .from(inventarios);
        const invMap = new Map(invs.map((i) => [i.maquinaId, i]));

        return mqs.map((m) => {
          const inv = invMap.get(m.id);
          const hw = (inv?.hardware || {}) as any;
          const discos = Array.isArray(hw.discos) ? hw.discos : [];
          const totBytes = discos.reduce((s: number, d: any) => s + Number(d.tamanhoBytes || d.Size || 0), 0);
          const livreBytes = discos.reduce((s: number, d: any) => s + Number(d.livreBytes || d.FreeSpace || 0), 0);
          return {
            id: m.id,
            hostname: m.hostname,
            apelido: m.apelido,
            grupoNome: m.grupoId ? (grupoMap.get(m.grupoId) || null) : null,
            tipoMaquina: m.tipoMaquina,
            online: m.online,
            soVersao: m.soVersao,
            versaoAgente: m.versaoAgente,
            criticidade: m.criticidade,
            responsavel: m.responsavel,
            vistoEm: m.vistoEm,
            cpu: hw.cpu?.modelo || null,
            ramGB: hw.ram?.totalBytes ? +(Number(hw.ram.totalBytes) / 1e9).toFixed(1) : null,
            discoTotalGB: totBytes ? Math.round(totBytes / 1e9) : null,
            discoLivreGB: livreBytes ? Math.round(livreBytes / 1e9) : null,
          };
        });
      });
      return reply.send({ itens });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro na frota");
      return reply.code(500).send({ erro: "erro ao listar frota" });
    }
  });

  // GET /api/relatorios/softwares — inventário de software consolidado.
  // filtros: grupoId, maquinaId, nome (busca parcial), pagina, limite
  app.get("/api/relatorios/softwares", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!(req.auth!.papel === "owner" || req.auth!.papel === "admin" ||
      (req.auth!.permissoes || []).includes("relatorios") || (req.auth!.permissoes || []).includes("inventario"))) {
      return reply.code(403).send({ erro: "sem permissão" });
    }
    const { tenantId } = req.auth!;
    const q = req.query as { grupoId?: string; maquinaId?: string; nome?: string; pagina?: string; limite?: string };
    const limite = Math.min(500, Math.max(10, Number(q.limite) || 100));
    const pagina = Math.max(0, Number(q.pagina) || 0);
    try {
      const dados = await comTenant(tenantId, async (tdb) => {
        const condMaq: any[] = [eq(maquinas.arquivada, false)];
        if (q.grupoId) condMaq.push(eq(maquinas.grupoId, q.grupoId));
        if (q.maquinaId) condMaq.push(eq(maquinas.id, q.maquinaId));

        const mqs = await tdb
          .select({ id: maquinas.id, hostname: maquinas.hostname, apelido: maquinas.apelido, grupoId: maquinas.grupoId })
          .from(maquinas)
          .where(and(...condMaq));

        const todosGrupos = await tdb.select({ id: grupos.id, nome: grupos.nome }).from(grupos);
        const grupoMap = new Map(todosGrupos.map((g) => [g.id, g.nome]));

        const condInv: any[] = [];
        if (q.maquinaId) condInv.push(eq(inventarios.maquinaId, q.maquinaId));

        const invs = await tdb
          .select({ maquinaId: inventarios.maquinaId, software: inventarios.software, atualizadoEm: inventarios.atualizadoEm })
          .from(inventarios)
          .where(condInv.length ? and(...condInv) : undefined);
        const invMap = new Map(invs.map((i) => [i.maquinaId, i]));

        const nomeBusca = q.nome ? q.nome.toLowerCase() : null;
        const resultado: any[] = [];
        for (const m of mqs) {
          const inv = invMap.get(m.id);
          if (!inv) continue;
          const swList = Array.isArray(inv.software) ? inv.software : [];
          for (const sw of swList as any[]) {
            const nome = sw.nome || sw.Name || sw.name || "";
            if (nomeBusca && !nome.toLowerCase().includes(nomeBusca)) continue;
            resultado.push({
              software: nome,
              versao: sw.versao || sw.Version || sw.version || null,
              fabricante: sw.fabricante || sw.Publisher || sw.publisher || null,
              maquinaId: m.id,
              hostname: m.hostname,
              apelido: m.apelido,
              grupoNome: m.grupoId ? (grupoMap.get(m.grupoId) || null) : null,
              detectadoEm: inv.atualizadoEm,
            });
          }
        }

        const total = resultado.length;
        const itens = resultado.slice(pagina * limite, (pagina + 1) * limite);
        return { total, itens };
      });
      return reply.send({ ...dados, pagina, limite });
    } catch (err) {
      app.log.error({ err, tenantId }, "Erro nos softwares");
      return reply.code(500).send({ erro: "erro ao listar softwares" });
    }
  });

  // GET /api/relatorios/exportar — exporta relatório como CSV (BOM UTF-8 para Excel).
  // tipo: frota | inventario | auditoria | uptime | softwares
  app.get("/api/relatorios/exportar", { preHandler: [app.requireAuth] }, async (req, reply) => {
    if (!(req.auth!.papel === "owner" || req.auth!.papel === "admin" ||
      (req.auth!.permissoes || []).includes("relatorios"))) {
      return reply.code(403).send({ erro: "sem permissão" });
    }
    const { tenantId } = req.auth!;
    const q = req.query as any;
    const tipo: string = q.tipo || "frota";

    function toCsv(linhas: string[][]): string {
      const bom = "﻿";
      return bom + linhas.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    }

    try {
      let csv = "";
      let filename = `${tipo}-${new Date().toISOString().slice(0, 10)}.csv`;

      if (tipo === "frota") {
        const itens = await comTenant(tenantId, async (tdb) => {
          const cond: any[] = [eq(maquinas.arquivada, false)];
          if (q.grupoId) cond.push(eq(maquinas.grupoId, q.grupoId));
          if (q.tipoMaquina) cond.push(eq(maquinas.tipoMaquina, q.tipoMaquina as any));
          if (q.online === "true") cond.push(eq(maquinas.online, true));
          if (q.online === "false") cond.push(eq(maquinas.online, false));
          if (q.criticidade) cond.push(eq(maquinas.criticidade, q.criticidade));
          if (q.responsavel) cond.push(sql`${maquinas.responsavel} ILIKE ${"%" + q.responsavel + "%"}`);
          if (q.semGrupo === "true") cond.push(isNull(maquinas.grupoId));
          if (q.so) cond.push(sql`${maquinas.soVersao} ILIKE ${"%" + q.so + "%"}`);
          if (q.q) cond.push(sql`(${maquinas.hostname} ILIKE ${"%" + q.q + "%"} OR ${maquinas.apelido} ILIKE ${"%" + q.q + "%"})`);
          const mqs = await tdb.select({ id: maquinas.id, hostname: maquinas.hostname, apelido: maquinas.apelido, grupoId: maquinas.grupoId, tipoMaquina: maquinas.tipoMaquina, online: maquinas.online, soVersao: maquinas.soVersao, versaoAgente: maquinas.versaoAgente, criticidade: maquinas.criticidade, responsavel: maquinas.responsavel, vistoEm: maquinas.vistoEm }).from(maquinas).where(and(...cond)).orderBy(asc(maquinas.hostname));
          const todosGrupos = await tdb.select({ id: grupos.id, nome: grupos.nome }).from(grupos);
          const gmap = new Map(todosGrupos.map((g) => [g.id, g.nome]));
          const invs = await tdb.select({ maquinaId: inventarios.maquinaId, hardware: inventarios.hardware }).from(inventarios);
          const imap = new Map(invs.map((i) => [i.maquinaId, i]));
          return mqs.map((m) => {
            const inv = imap.get(m.id); const hw = (inv?.hardware || {}) as any;
            const discos = Array.isArray(hw.discos) ? hw.discos : [];
            const tot = discos.reduce((s: number, d: any) => s + Number(d.tamanhoBytes || d.Size || 0), 0);
            const liv = discos.reduce((s: number, d: any) => s + Number(d.livreBytes || d.FreeSpace || 0), 0);
            return [m.hostname, m.apelido || "", m.grupoId ? (gmap.get(m.grupoId) || "") : "", m.tipoMaquina, m.online ? "Online" : "Offline", m.soVersao || "", m.versaoAgente || "", hw.cpu?.modelo || "", hw.ram?.totalBytes ? String(+(Number(hw.ram.totalBytes) / 1e9).toFixed(1)) : "", tot ? String(Math.round(tot / 1e9)) : "", liv ? String(Math.round(liv / 1e9)) : "", m.criticidade || "", m.responsavel || "", m.vistoEm ? new Date(m.vistoEm).toISOString() : ""];
          });
        });
        csv = toCsv([["Hostname", "Apelido", "Empresa/Grupo", "Tipo", "Status", "SO", "Versao_Agente", "CPU", "RAM_GB", "Disco_Total_GB", "Disco_Livre_GB", "Criticidade", "Responsavel", "Visto_Em"], ...itens]);

      } else if (tipo === "inventario") {
        const itens = await comTenant(tenantId, async (tdb) => {
          const mq = await tdb.select().from(maquinas).where(eq(maquinas.arquivada, false));
          const invs = await tdb.select({ maquinaId: inventarios.maquinaId, hardware: inventarios.hardware, so: inventarios.so, software: inventarios.software, em: inventarios.atualizadoEm }).from(inventarios);
          const imap = new Map(invs.map((i) => [i.maquinaId, i]));
          return mq.map((m) => {
            const inv = imap.get(m.id); const hw = (inv?.hardware || {}) as any;
            const discos = Array.isArray(hw.discos) ? hw.discos : [];
            const tot = discos.reduce((s: number, d: any) => s + Number(d.tamanhoBytes || d.Size || 0), 0);
            const liv = discos.reduce((s: number, d: any) => s + Number(d.livreBytes || d.FreeSpace || 0), 0);
            const soStr = (inv?.so as any)?.nome ? `${(inv!.so as any).nome} ${(inv!.so as any).versao || ""}`.trim() : "";
            return [m.hostname, m.apelido || "", m.online ? "Online" : "Offline", m.tipoMaquina, soStr, hw.cpu?.modelo || "", hw.ram?.totalBytes ? String(+(Number(hw.ram.totalBytes) / 1e9).toFixed(1)) : "", tot ? String(Math.round(tot / 1e9)) : "", liv ? String(Math.round(liv / 1e9)) : "", String(Array.isArray(inv?.software) ? inv!.software.length : 0), inv?.em ? new Date(inv.em).toISOString() : ""];
          });
        });
        csv = toCsv([["Hostname", "Apelido", "Status", "Tipo", "SO", "CPU", "RAM_GB", "Disco_Total_GB", "Disco_Livre_GB", "Softwares", "Atualizado_Em"], ...itens]);

      } else if (tipo === "auditoria") {
        const limAud = Math.min(10000, Math.max(10, Number(q.limite) || 5000));
        const itens = await comTenant(tenantId, async (tdb) => {
          const cond: any[] = [];
          if (q.de) cond.push(sql`${logsServicosWindows.executadoEm} >= ${new Date(q.de)}`);
          if (q.ate) cond.push(sql`${logsServicosWindows.executadoEm} <= ${new Date(q.ate)}`);
          if (q.maquinaId) cond.push(eq(logsServicosWindows.maquinaId, q.maquinaId));
          if (q.status) cond.push(eq(logsServicosWindows.statusResultado, q.status));
          if (q.q) cond.push(sql`(${logsServicosWindows.servicoNome} ILIKE ${"%" + q.q + "%"} OR ${logsServicosWindows.acaoExecutada} ILIKE ${"%" + q.q + "%"})`);
          const rows = await tdb.select({ em: logsServicosWindows.executadoEm, usuario: usuarios.email, hostname: maquinas.hostname, apelido: maquinas.apelido, tipo: logsServicosWindows.servicoNome, acao: logsServicosWindows.acaoExecutada, status: logsServicosWindows.statusResultado, detalhe: logsServicosWindows.detalhesErro }).from(logsServicosWindows).leftJoin(usuarios, eq(logsServicosWindows.usuarioId, usuarios.id)).leftJoin(maquinas, eq(logsServicosWindows.maquinaId, maquinas.id)).where(cond.length ? and(...cond) : undefined).orderBy(desc(logsServicosWindows.executadoEm)).limit(limAud);
          return rows.map((r) => [new Date(r.em).toISOString(), r.usuario || "", r.apelido || r.hostname || "", r.tipo || "", r.acao || "", r.status || "", r.detalhe || ""]);
        });
        csv = toCsv([["Data_Hora", "Usuario", "Maquina", "Tipo", "Acao", "Status", "Detalhe"], ...itens]);

      } else if (tipo === "uptime") {
        const dias = Math.min(180, Math.max(1, Number(q.dias) || 30));
        const desde = new Date(Date.now() - dias * 86400000);
        const agora = Date.now();
        const itens = await comTenant(tenantId, async (tdb) => {
          const mq = await tdb.select().from(maquinas).where(eq(maquinas.arquivada, false));
          const eventos = await tdb.select({ maquinaId: presencaLog.maquinaId, online: presencaLog.online, em: presencaLog.em }).from(presencaLog).where(gte(presencaLog.em, desde)).orderBy(asc(presencaLog.em));
          const porMaquina = new Map<string, Array<{ online: boolean; em: number }>>();
          for (const e of eventos) {
            if (!porMaquina.has(e.maquinaId)) porMaquina.set(e.maquinaId, []);
            porMaquina.get(e.maquinaId)!.push({ online: e.online, em: new Date(e.em).getTime() });
          }
          return mq.map((m) => {
            const evs = porMaquina.get(m.id) || [];
            let uptime: number | null = null;
            if (evs.length > 0) {
              let cursor = evs[0]!.em, estado = evs[0]!.online, onlineMs = 0;
              for (let i = 1; i < evs.length; i++) { if (estado) onlineMs += evs[i]!.em - cursor; cursor = evs[i]!.em; estado = evs[i]!.online; }
              if (estado) onlineMs += agora - cursor;
              const janelaMs = agora - evs[0]!.em;
              uptime = janelaMs > 0 ? Math.round((onlineMs / janelaMs) * 1000) / 10 : (m.online ? 100 : 0);
            }
            return [m.hostname, m.apelido || "", m.online ? "Online" : "Offline", uptime != null ? String(uptime) + "%" : "sem dados", evs.length > 0 ? new Date(evs[0]!.em).toISOString() : ""];
          });
        });
        csv = toCsv([["Hostname", "Apelido", "Status_Atual", `Uptime_${dias}d`, "Desde"], ...itens]);

      } else {
        return reply.code(400).send({ erro: "tipo inválido. Use: frota, inventario, auditoria, uptime" });
      }

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      return reply.send(csv);
    } catch (err) {
      app.log.error({ err, tenantId, tipo }, "Erro ao exportar relatório");
      return reply.code(500).send({ erro: "erro ao exportar relatório" });
    }
  });
};
