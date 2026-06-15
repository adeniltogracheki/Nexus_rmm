export interface TerminalSession {
  adminSocketId: string;
  agentSocketId: string;
  machineId: string;
}

const sessions = new Map<string, TerminalSession>();

export function registrarTerminalSession(sessionId: string, session: TerminalSession) {
  sessions.set(sessionId, session);
}

export function obterTerminalSession(sessionId: string): TerminalSession | undefined {
  return sessions.get(sessionId);
}

export function removerTerminalSession(sessionId: string) {
  sessions.delete(sessionId);
}

export function obterTodasSessions(): Map<string, TerminalSession> {
  return sessions;
}
