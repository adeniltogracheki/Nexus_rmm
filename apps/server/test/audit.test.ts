import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { config } from "../src/config";

const { Pool } = pg;

// Critério de aceite §1.7: 2 logs encadeiam o hash; um UPDATE direto quebra a
// verificação da cadeia. Tudo dentro de uma transação que sofre ROLLBACK no fim.
test("auditoria encadeia o hash e detecta adulteração", async (t) => {
  const pool = new Pool({ connectionString: config.DATABASE_URL });
  const client = await pool.connect();
  t.after(async () => {
    client.release();
    await pool.end();
  });

  await client.query("BEGIN");
  try {
    const slug = `teste-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    const tenant = (
      await client.query(
        "INSERT INTO tenants (nome, slug) VALUES ($1, $2) RETURNING id",
        ["Tenant de Teste", slug],
      )
    ).rows[0];

    // RLS: define o tenant da conexão (local à transação).
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant.id]);

    const maquina = (
      await client.query(
        "INSERT INTO maquinas (tenant_id, hostname, fingerprint) VALUES ($1, $2, $3) RETURNING id",
        [tenant.id, "host-teste", `fp-${slug}`],
      )
    ).rows[0];

    const inserirLog = async (servico: string, acao: string) =>
      (
        await client.query(
          `INSERT INTO logs_servicos_windows
             (tenant_id, maquina_id, servico_nome, acao_executada, status_resultado)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, hash_anterior, hash_registro`,
          [tenant.id, maquina.id, servico, acao, "SUCESSO"],
        )
      ).rows[0];

    const a = await inserirLog("spooler", "RESTART");
    const b = await inserirLog("wuauserv", "STOP");

    // Encadeamento.
    assert.equal(a.hash_anterior, null, "o primeiro log não tem hash anterior");
    assert.ok(a.hash_registro, "o primeiro log recebeu um hash");
    assert.equal(b.hash_anterior, a.hash_registro, "o 2º log encadeia no 1º");
    assert.ok(b.hash_registro && b.hash_registro !== a.hash_registro, "hashes distintos");

    // Verificação: recalcula o hash da linha com a MESMA função do trigger.
    const intacto = async (id: string): Promise<boolean> =>
      (
        await client.query(
          `SELECT (hash_registro = encode(digest(nexus_audit_payload(l), 'sha256'), 'hex')) AS intacto
             FROM logs_servicos_windows l WHERE id = $1`,
          [id],
        )
      ).rows[0].intacto;

    assert.equal(await intacto(a.id), true, "antes da adulteração o hash confere");

    // Adulteração direta da linha (o dono ignora o REVOKE; RLS permite com o GUC setado).
    await client.query(
      "UPDATE logs_servicos_windows SET status_resultado = $1 WHERE id = $2",
      ["ADULTERADO", a.id],
    );

    assert.equal(
      await intacto(a.id),
      false,
      "após o UPDATE direto a verificação da cadeia falha (tamper-evident)",
    );
  } finally {
    await client.query("ROLLBACK");
  }
});
