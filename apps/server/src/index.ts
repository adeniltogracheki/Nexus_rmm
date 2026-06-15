import { config } from "./config";
import { pool } from "./db/index";
import { redis } from "./redis";
import { buildApp } from "./app";
import { iniciarGatewayAgentes, encerrarGatewayAgentes } from "./gateway/agent";
import { encerrarSocketAdmin } from "./gateway/admin";
import { iniciarAgendador, encerrarAgendador } from "./scheduler";

const app = await buildApp();

const start = async (): Promise<void> => {
  try {
    await app.listen({ port: config.SERVER_PORT, host: "0.0.0.0" });
    await iniciarGatewayAgentes(app);
    iniciarAgendador();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, "encerrando...");
  try {
    encerrarAgendador();
    await encerrarGatewayAgentes();
    await encerrarSocketAdmin();
    await app.close();
    await pool.end();
    redis.disconnect();
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

void start();
