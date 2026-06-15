import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index";
import { config } from "../config";

const { Pool } = pg;

export const pool = new Pool({ connectionString: config.DATABASE_URL });
export const db = drizzle(pool, { schema });
export type DB = typeof db;
