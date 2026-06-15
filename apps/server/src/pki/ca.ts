import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import forge from "node-forge";
import { config } from "../config";

export interface CaBundle {
  caKeyPem: string;
  caCertPem: string;
  caKey: forge.pki.rsa.PrivateKey;
  caCert: forge.pki.Certificate;
}

let caBundleCache: CaBundle | null = null;

export function obterOuCriarCa(): CaBundle {
  if (caBundleCache) {
    return caBundleCache;
  }

  const caDir = path.resolve(config.CA_DIR);
  const keyPath = path.join(caDir, "ca.key");
  const certPath = path.join(caDir, "ca.crt");

  // Garante que o diretorio secrets existe
  if (!fs.existsSync(caDir)) {
    fs.mkdirSync(caDir, { recursive: true });
  }

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const caKeyPem = fs.readFileSync(keyPath, "utf8");
    const caCertPem = fs.readFileSync(certPath, "utf8");

    const caKey = forge.pki.privateKeyFromPem(caKeyPem) as forge.pki.rsa.PrivateKey;
    const caCert = forge.pki.certificateFromPem(caCertPem);

    caBundleCache = { caKeyPem, caCertPem, caKey, caCert };
    return caBundleCache;
  }

  // Se nao existir, vamos gerar
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  
  // Vence em 10 anos
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: "commonName", value: "Nexus RMM Root CA" },
    { name: "organizationName", value: "GMTec" },
    { name: "organizationalUnitName", value: "Nexus PKI Department" },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    {
      name: "basicConstraints",
      cA: true,
    },
    {
      name: "keyUsage",
      keyCertSign: true,
      digitalSignature: true,
      nonRepudiation: true,
      keyEncipherment: true,
      dataEncipherment: true,
    },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const caKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const caCertPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(keyPath, caKeyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, caCertPem);

  caBundleCache = {
    caKeyPem,
    caCertPem,
    caKey: keys.privateKey,
    caCert: cert,
  };

  return caBundleCache;
}

export interface ServerBundle {
  serverKeyPem: string;
  serverCertPem: string;
}

let serverBundleCache: ServerBundle | null = null;

export function obterOuCriarCertificadoServidor(hostnames: string[]): ServerBundle {
  if (serverBundleCache) {
    return serverBundleCache;
  }

  const { caKey, caCert } = obterOuCriarCa();

  const caDir = path.resolve(config.CA_DIR);
  const keyPath = path.join(caDir, "server.key");
  const certPath = path.join(caDir, "server.crt");

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const serverKeyPem = fs.readFileSync(keyPath, "utf8");
    const serverCertPem = fs.readFileSync(certPath, "utf8");
    serverBundleCache = { serverKeyPem, serverCertPem };
    return serverBundleCache;
  }

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = crypto.randomBytes(16).toString("hex");
  cert.validity.notBefore = new Date();
  
  // Válido por 2 anos
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 2);

  const attrs = [
    { name: "commonName", value: hostnames[0] || "localhost" },
    { name: "organizationName", value: "GMTec" },
    { name: "organizationalUnitName", value: "Nexus Server Gateway" },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(caCert.subject.attributes);

  const altNames = hostnames.map((name) => {
    const isIp = /^[0-9.]+$/.test(name);
    return isIp ? { type: 7, ip: name } : { type: 2, value: name };
  });

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
      serverAuth: true,
    },
    {
      name: "subjectAltName",
      altNames,
    },
  ]);

  cert.sign(caKey, forge.md.sha256.create());

  const serverKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const serverCertPem = forge.pki.certificateToPem(cert);

  fs.writeFileSync(keyPath, serverKeyPem, { mode: 0o600 });
  fs.writeFileSync(certPath, serverCertPem);

  serverBundleCache = { serverKeyPem, serverCertPem };
  return serverBundleCache;
}

