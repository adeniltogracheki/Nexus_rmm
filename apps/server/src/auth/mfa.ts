import { authenticator } from "otplib";
import QRCode from "qrcode";

const EMISSOR = "Nexus RMM";

export function gerarSegredoMfa(): string {
  return authenticator.generateSecret();
}

export function uriOtpauth(email: string, segredo: string): string {
  return authenticator.keyuri(email, EMISSOR, segredo);
}

export function qrDataUrl(otpauthUri: string): Promise<string> {
  return QRCode.toDataURL(otpauthUri);
}

export function validarCodigoMfa(segredo: string, codigo: string): boolean {
  authenticator.options = { window: 1 };
  return authenticator.verify({ token: codigo.trim(), secret: segredo });
}
