import { z } from "zod";

export const PapelUsuario = z.enum(["owner", "admin", "operator", "viewer"]);
export type PapelUsuario = z.infer<typeof PapelUsuario>;

export const LoginRequest = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
  codigoMfa: z.string().optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const Usuario = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  papel: PapelUsuario,
  tenantId: z.string().uuid(),
  mfaAtivo: z.boolean(),
});
export type Usuario = z.infer<typeof Usuario>;

export const LoginResponse = z.object({
  ok: z.literal(true),
  usuario: Usuario,
  precisaConfigurarMfa: z.boolean(),
});
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MfaSetupResponse = z.object({
  otpauthUri: z.string(),
  qrDataUrl: z.string(),
});
export type MfaSetupResponse = z.infer<typeof MfaSetupResponse>;

export const MfaVerifyRequest = z.object({
  codigo: z.string().min(6),
  secret: z.string().optional(),
});
export type MfaVerifyRequest = z.infer<typeof MfaVerifyRequest>;

export const CriarTokenEnrollmentRequest = z.object({
  descricao: z.string().optional(),
  maxUsos: z.number().int().positive().max(1000).default(1),
  expiraEmHoras: z.number().int().positive().max(8760).optional(),
});
export type CriarTokenEnrollmentRequest = z.infer<typeof CriarTokenEnrollmentRequest>;
