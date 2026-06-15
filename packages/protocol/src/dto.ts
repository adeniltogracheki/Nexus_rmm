import { z } from "zod";

export const ServiceState = z.enum([
  "Running",
  "Stopped",
  "Paused",
  "StartPending",
  "StopPending",
  "Unknown",
]);
export type ServiceState = z.infer<typeof ServiceState>;

export const ServiceStartup = z.enum(["Automatic", "Manual", "Disabled"]);
export type ServiceStartup = z.infer<typeof ServiceStartup>;

export const ServiceCategory = z.enum(["critico", "negocio", "desativado", "outro"]);
export type ServiceCategory = z.infer<typeof ServiceCategory>;

export const ServiceItem = z.object({
  nome: z.string().min(1),
  displayName: z.string(),
  estado: ServiceState,
  tipoInicializacao: ServiceStartup,
  categoria: ServiceCategory,
  watchdogAtivo: z.boolean(),
});
export type ServiceItem = z.infer<typeof ServiceItem>;

/** Inventário completo de serviços de uma máquina. */
export const ServiceInventory = z.object({
  machineId: z.string().uuid(),
  capturadoEm: z.number().int(),
  servicos: z.array(ServiceItem),
});
export type ServiceInventory = z.infer<typeof ServiceInventory>;

/** Apenas o que mudou desde o último inventário. */
export const ServiceDelta = z.object({
  machineId: z.string().uuid(),
  capturadoEm: z.number().int(),
  alterados: z.array(ServiceItem),
  removidos: z.array(z.string()),
});
export type ServiceDelta = z.infer<typeof ServiceDelta>;

export const Heartbeat = z.object({
  machineId: z.string().uuid(),
  versaoAgente: z.string(),
  uptimeSegundos: z.number().int().nonnegative(),
  enviadoEm: z.number().int(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

export const AgentHelloPayload = z.object({
  hostname: z.string().min(1),
  soVersao: z.string().nullable().optional(),
  versaoAgente: z.string().min(1),
});
export type AgentHelloPayload = z.infer<typeof AgentHelloPayload>;

export const MachinePresencePayload = z.object({
  machineId: z.string().uuid(),
  tenantId: z.string().uuid(),
  online: z.boolean(),
  vistoEm: z.number().int(),
});
export type MachinePresencePayload = z.infer<typeof MachinePresencePayload>;

export const HardwareInfo = z.object({
  cpu: z.object({
    modelo: z.string(),
    cores: z.number().int(),
    threads: z.number().int(),
  }),
  ram: z.object({
    totalBytes: z.number().int(),
  }),
  discos: z.array(
    z.object({
      caminho: z.string(),
      tamanhoBytes: z.number().int(),
      livreBytes: z.number().int(),
    })
  ),
  fabricante: z.string().nullable().optional(),
  modeloPlaca: z.string().nullable().optional(),
});
export type HardwareInfo = z.infer<typeof HardwareInfo>;

export const OsInfo = z.object({
  nome: z.string(),
  versao: z.string(),
  arquitetura: z.string(),
  dataInstalacao: z.string().nullable().optional(),
  bootTime: z.string().nullable().optional(),
});
export type OsInfo = z.infer<typeof OsInfo>;

export const NetworkInterface = z.object({
  interface: z.string(),
  mac: z.string(),
  ips: z.array(z.string()),
});
export type NetworkInterface = z.infer<typeof NetworkInterface>;

export const SoftwareItem = z.object({
  nome: z.string(),
  versao: z.string().nullable().optional(),
  fornecedor: z.string().nullable().optional(),
  dataInstalacao: z.string().nullable().optional(),
});
export type SoftwareItem = z.infer<typeof SoftwareItem>;

export const MachineInventoryPayload = z.object({
  machineId: z.string().uuid(),
  capturadoEm: z.number().int(),
  hardware: HardwareInfo,
  so: OsInfo,
  rede: z.array(NetworkInterface),
  software: z.array(SoftwareItem),
  // Tipo de dispositivo detectado automaticamente via chassis type (WMI / DMI / modelo)
  tipoMaquina: z.enum(["pc", "notebook", "servidor", "mobile", "tablet"]).optional(),
  // MAC address primário para Wake-on-LAN
  macAddress: z.string().optional(),
});
export type MachineInventoryPayload = z.infer<typeof MachineInventoryPayload>;

