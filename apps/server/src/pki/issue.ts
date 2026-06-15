import crypto from "node:crypto";
import forge from "node-forge";
import { obterOuCriarCa } from "./ca";

/**
 * Emite um certificado X.509 de cliente mTLS assinado pela CA raiz interna.
 * 
 * @param machineId ID da máquina (será o Common Name - CN)
 * @param tenantId ID do tenant (será a Organization - O)
 * @param chavePublicaPem Chave pública RSA do agente em formato PEM
 * @returns Certificado X.509 de cliente em formato PEM
 */
export function emitirCertificadoCliente(
  machineId: string,
  tenantId: string,
  chavePublicaPem: string,
): string {
  const { caKey, caCert } = obterOuCriarCa();

  // Parse da chave pública do agente
  const userPublicKey = forge.pki.publicKeyFromPem(chavePublicaPem);

  // Criação do certificado do agente
  const cert = forge.pki.createCertificate();
  cert.publicKey = userPublicKey;
  
  // Número de série aleatório de 128 bits
  cert.serialNumber = crypto.randomBytes(16).toString("hex");
  
  cert.validity.notBefore = new Date();
  // Válido por 2 anos
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  // CN = machineId (identificação da máquina)
  // O = tenantId (segregação RLS do tenant no gateway)
  const attrs = [
    { name: "commonName", value: machineId },
    { name: "organizationName", value: tenantId },
  ];
  cert.setSubject(attrs);

  // Issuer é a CA raiz
  cert.setIssuer(caCert.subject.attributes);

  // Configurações do certificado de cliente mTLS
  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: false,
    },
    {
      name: "keyUsage",
      digitalSignature: true,
      keyEncipherment: true,
    },
    {
      name: "extKeyUsage",
      clientAuth: true, // Habilita o uso em autenticação de cliente TLS
    },
  ]);

  // Assinatura usando SHA-256 e a chave privada da CA
  cert.sign(caKey, forge.md.sha256.create());

  return forge.pki.certificateToPem(cert);
}
