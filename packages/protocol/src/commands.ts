import { z } from "zod";

const CommandEnvelope = z.object({
  commandId: z.string().uuid(),
  machineId: z.string().uuid(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  signature: z.string().min(1),
});

export const ServiceActionCommand = CommandEnvelope.extend({
  type: z.literal("service.action"),
  service: z.string().min(1),
  action: z.enum(["START", "STOP", "RESTART", "CHANGE_TYPE"]),
  startupType: z.enum(["Automatic", "Manual", "Disabled"]).optional(),
});

export const PtyInputCommand = CommandEnvelope.extend({
  type: z.literal("pty.input"),
  sessionId: z.string().uuid(),
  data: z.string(),
});

export const SetWatchdogCommand = CommandEnvelope.extend({
  type: z.literal("service.set-watchdog"),
  service: z.string().min(1),
  enabled: z.boolean(),
});

export const ShellRunCommand = CommandEnvelope.extend({
  type: z.literal("shell.run"),
  shell: z.enum(["powershell", "cmd"]).default("powershell"),
  command: z.string().min(1).max(8000),
});

export const FileReadCommand = CommandEnvelope.extend({
  type: z.literal("file.read"),
  path: z.string().min(1).max(4000),
});

export const FileWriteCommand = CommandEnvelope.extend({
  type: z.literal("file.write"),
  path: z.string().min(1).max(4000),
  conteudo: z.string(), // base64
});

export const AgentCommand = z.discriminatedUnion("type", [
  ServiceActionCommand,
  PtyInputCommand,
  SetWatchdogCommand,
  ShellRunCommand,
  FileReadCommand,
  FileWriteCommand,
]);
export type AgentCommand = z.infer<typeof AgentCommand>;

export const CommandResult = z.object({
  commandId: z.string().uuid(),
  status: z.enum(["SUCESSO", "FALHA"]),
  error: z.string().optional(),
  output: z.string().optional(),
  finishedAt: z.number().int(),
});
export type CommandResult = z.infer<typeof CommandResult>;

export function obterPayloadAssinatura(cmd: Omit<AgentCommand, "signature">): string {
  if (cmd.type === "service.action") {
    const c = cmd as Omit<typeof ServiceActionCommand._type, "signature">;
    return [
      c.commandId,
      c.machineId,
      c.issuedAt.toString(),
      c.expiresAt.toString(),
      c.type,
      c.service,
      c.action,
      c.startupType ?? "",
    ].join("|");
  } else if (cmd.type === "service.set-watchdog") {
    const c = cmd as Omit<typeof SetWatchdogCommand._type, "signature">;
    return [
      c.commandId,
      c.machineId,
      c.issuedAt.toString(),
      c.expiresAt.toString(),
      c.type,
      c.service,
      c.enabled.toString(),
    ].join("|");
  } else if (cmd.type === "pty.input") {
    const c = cmd as Omit<typeof PtyInputCommand._type, "signature">;
    return [
      c.commandId,
      c.machineId,
      c.issuedAt.toString(),
      c.expiresAt.toString(),
      c.type,
      c.sessionId,
      c.data,
    ].join("|");
  } else if (cmd.type === "shell.run") {
    const c = cmd as Omit<typeof ShellRunCommand._type, "signature">;
    return [
      c.commandId,
      c.machineId,
      c.issuedAt.toString(),
      c.expiresAt.toString(),
      c.type,
      c.shell,
      c.command,
    ].join("|");
  } else if (cmd.type === "file.read") {
    const c = cmd as Omit<typeof FileReadCommand._type, "signature">;
    return [c.commandId, c.machineId, c.issuedAt.toString(), c.expiresAt.toString(), c.type, c.path].join("|");
  } else if (cmd.type === "file.write") {
    const c = cmd as Omit<typeof FileWriteCommand._type, "signature">;
    return [c.commandId, c.machineId, c.issuedAt.toString(), c.expiresAt.toString(), c.type, c.path, c.conteudo].join("|");
  }
  throw new Error("Tipo de comando desconhecido para assinatura");
}

