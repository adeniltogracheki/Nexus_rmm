/**
 * Endpoint de deploy do CI — recebe APK Android como body binário e salva no servidor.
 * Autenticação: Bearer token estático (CI_DEPLOY_TOKEN no .env).
 * Sem dependência de SSH — o GitHub Actions usa curl com --data-binary.
 *
 * POST /api/ci/deploy-apk?sha=abc12345&version=0.7.1
 *   Header: Authorization: Bearer <CI_DEPLOY_TOKEN>
 *   Header: Content-Type: application/octet-stream
 *   Body:   bytes do APK
 *
 * Resposta: { ok: true, path, version, sha, bytes }
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config";

export const ciDeployRoutes: FastifyPluginAsync = async (app) => {
  // Registra parser para application/octet-stream (recebe Buffer)
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );

  app.post("/api/ci/deploy-apk", async (req, reply) => {
    // ── Autenticação por token estático ──────────────────────────────────────
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (!config.CI_DEPLOY_TOKEN) {
      return reply.code(503).send({ erro: "CI_DEPLOY_TOKEN não configurado no servidor" });
    }

    const expected = Buffer.from(config.CI_DEPLOY_TOKEN);
    const received = Buffer.alloc(expected.length);
    Buffer.from(token).copy(received);
    if (!crypto.timingSafeEqual(expected, received)) {
      return reply.code(401).send({ erro: "token inválido" });
    }

    // ── Valida body ───────────────────────────────────────────────────────────
    const buf = req.body as Buffer | undefined;
    if (!buf || buf.length === 0) {
      return reply.code(400).send({ erro: "body vazio — envie o APK como application/octet-stream" });
    }

    // ── Salva o APK ───────────────────────────────────────────────────────────
    const q       = req.query as { sha?: string; version?: string };
    const sha     = (q.sha ?? crypto.randomBytes(4).toString("hex")).slice(0, 8).replace(/[^a-f0-9]/g, "x");
    const version = (q.version ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "");

    const dir      = config.ANDROID_RELEASES_DIR;
    fs.mkdirSync(dir, { recursive: true });

    const fileName   = `app-debug-${sha}.apk`;
    const filePath   = path.join(dir, fileName);
    const latestPath = path.join(dir, "latest.apk");

    fs.writeFileSync(filePath, buf);

    // Atualiza latest.apk (symlink)
    try { fs.unlinkSync(latestPath); } catch { /* não existia */ }
    fs.symlinkSync(filePath, latestPath);

    app.log.info(
      { version, sha, bytes: buf.length, path: filePath },
      "CI: APK Android recebido e salvo",
    );

    return reply.send({ ok: true, path: filePath, version, sha, bytes: buf.length });
  });
};
