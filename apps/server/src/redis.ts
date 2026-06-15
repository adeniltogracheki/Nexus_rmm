import Redis from "ioredis";
import { config } from "./config";

// lazyConnect: conecta na primeira operação (ex.: ping do /readyz).
export const redis = new Redis(config.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 2,
});
