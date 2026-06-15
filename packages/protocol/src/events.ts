export const Ev = {
  // agente -> servidor
  AgentHello: "agent:hello",
  AgentHeartbeat: "agent:heartbeat",
  ServiceInventory: "agent:service-inventory",
  ServiceDelta: "agent:service-delta",
  CommandResult: "agent:command-result",
  WatchdogAlert: "agent:watchdog-alert",
  AgentInventory: "agent:inventory",
  // servidor -> agente
  Command: "server:command",
  UpdateAvailable: "server:update-available",
  // painel <-> servidor (namespace /admin)
  MachinePresence: "admin:machine-presence",
  ServiceStateChanged: "admin:service-state-changed",
} as const;
export type EventName = (typeof Ev)[keyof typeof Ev];
