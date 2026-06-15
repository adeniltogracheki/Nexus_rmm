import { z } from "zod";

export const EnrollRequest = z.object({
  token: z.string().min(1),
  hostname: z.string().min(1),
  chavePublicaPem: z.string().min(1),
  soVersao: z.string().nullish(),
  versaoAgente: z.string().nullish(),
  biosUuid: z.string().nullish(),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

export const EnrollResponse = z.object({
  machineId: z.string().uuid(),
  certificadoClientePem: z.string().min(1),
  certificadoCaPem: z.string().min(1),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;
