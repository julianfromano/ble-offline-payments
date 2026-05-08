/**
 * Server-side crypto helpers.
 * Uses Node.js built-in crypto.subtle (Ed25519 available since Node 16).
 */

import { webcrypto } from 'node:crypto';
const subtle = webcrypto.subtle;

export interface ServerKeyPair {
  publicKeyRaw: Uint8Array;   // 32 bytes
  publicKeyB64: string;
  privateKey: webcrypto.CryptoKey;
}

let _serverKeyPair: ServerKeyPair | null = null;

/** Generate (or return cached) the server Ed25519 signing key. */
export async function getServerKeyPair(): Promise<ServerKeyPair> {
  if (_serverKeyPair) return _serverKeyPair;
  const kp = await subtle.generateKey(
    { name: 'Ed25519' } as AlgorithmIdentifier,
    false,
    ['sign', 'verify']
  ) as webcrypto.CryptoKeyPair;

  const rawBuf = await subtle.exportKey('raw', kp.publicKey);
  const raw = new Uint8Array(rawBuf);
  _serverKeyPair = {
    publicKeyRaw: raw,
    publicKeyB64: Buffer.from(raw).toString('base64'),
    privateKey: kp.privateKey,
  };
  return _serverKeyPair;
}

/** Sign a message with the server Ed25519 key. Returns base64url signature. */
export async function serverSign(data: Uint8Array): Promise<string> {
  const { privateKey } = await getServerKeyPair();
  const sigBuf = await subtle.sign({ name: 'Ed25519' } as AlgorithmIdentifier, privateKey, data);
  return Buffer.from(sigBuf).toString('base64url');
}

/** Verify that a payload was signed by a given Ed25519 pubkey (raw, base64). */
export async function verifyEd25519(
  pubKeyB64: string,
  data: Uint8Array,
  sigB64: string
): Promise<boolean> {
  try {
    const pubRaw = Buffer.from(pubKeyB64, 'base64');
    const sig = Buffer.from(sigB64, 'base64url');
    const key = await subtle.importKey(
      'raw', pubRaw,
      { name: 'Ed25519' } as AlgorithmIdentifier,
      false, ['verify']
    );
    return await subtle.verify({ name: 'Ed25519' } as AlgorithmIdentifier, key, sig, data);
  } catch {
    return false;
  }
}

/** SHA-256 hash of arbitrary bytes, returned as hex string. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const buf = await subtle.digest('SHA-256', data);
  return Buffer.from(buf).toString('hex');
}

/** Canonicalize an object (sorted keys, no whitespace) and return UTF-8 bytes. */
export function canonicalBytes(obj: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(obj));
}

function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(',')}}`;
}

/** Simple session token: base64url-encoded JSON signed with the server key. */
export async function issueSessionToken(payload: Record<string, unknown>): Promise<string> {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = await serverSign(new TextEncoder().encode(body));
  return `${body}.${sig}`;
}

export function decodeSessionToken(token: string): Record<string, unknown> | null {
  try {
    const [body] = token.split('.');
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
