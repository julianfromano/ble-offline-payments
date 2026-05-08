/**
 * In-memory store. Replace with a real database for production.
 * All IDs are UUIDs; balances are in centavos (integer).
 */

import { webcrypto } from 'node:crypto';

export interface User {
  user_id: string;
  device_pubkey_b64: string; // Ed25519 or P-256 raw pubkey, base64
  platform: 'android' | 'ios' | 'web';
  device_model: string;
  registered_at: string;     // ISO-8601
  balance: number;           // centavos
  active: boolean;           // false = blocked (double-spend detected)
}

export interface OfflineToken {
  token_id: string;
  user_id: string;
  balance: number;
  currency: string;
  chain_hash: string;        // SHA-256 of previous state (H0 for first token)
  max_per_tx: number;
  max_per_hour: number;
  min_interval_ms: number;
  valid_until: string;       // ISO-8601
  issued_at: string;
  server_sig: string;        // Ed25519 sig over canonical JSON (base64url)
}

export interface SyncedReceipt {
  receipt_id: string;
  user_id: string;
  vendor_id: string;
  amount: number;
  currency: string;
  tx_id: string;
  chain_hash_before: string;
  chain_hash_after: string;
  synced_at: string;
  status: 'settled' | 'rejected' | 'pending';
}

const users = new Map<string, User>();
const tokens = new Map<string, OfflineToken>(); // key = token_id
const tokenByUser = new Map<string, string>();  // user_id → current token_id
const receipts = new Map<string, SyncedReceipt>();
const blacklist = new Set<string>();            // blocked user_ids

export const db = {
  // ---- Users ---------------------------------------------------------------
  createUser(data: Omit<User, 'user_id' | 'registered_at' | 'balance' | 'active'>): User {
    const u: User = {
      user_id: webcrypto.randomUUID(),
      registered_at: new Date().toISOString(),
      balance: 0,
      active: true,
      ...data,
    };
    users.set(u.user_id, u);
    return u;
  },

  getUser(user_id: string): User | undefined {
    return users.get(user_id);
  },

  getUserByPubkey(pubkey: string): User | undefined {
    for (const u of users.values()) {
      if (u.device_pubkey_b64 === pubkey) return u;
    }
    return undefined;
  },

  blockUser(user_id: string): void {
    const u = users.get(user_id);
    if (u) { u.active = false; users.set(user_id, u); }
    blacklist.add(user_id);
  },

  // ---- Tokens --------------------------------------------------------------
  saveToken(t: OfflineToken): void {
    tokens.set(t.token_id, t);
    tokenByUser.set(t.user_id, t.token_id);
  },

  getCurrentToken(user_id: string): OfflineToken | undefined {
    const tid = tokenByUser.get(user_id);
    return tid ? tokens.get(tid) : undefined;
  },

  // ---- Receipts ------------------------------------------------------------
  saveReceipt(r: SyncedReceipt): void {
    receipts.set(r.receipt_id, r);
  },

  getReceiptByTxId(tx_id: string): SyncedReceipt | undefined {
    for (const r of receipts.values()) {
      if (r.tx_id === tx_id) return r;
    }
    return undefined;
  },

  getUserReceipts(user_id: string): SyncedReceipt[] {
    return [...receipts.values()].filter((r) => r.user_id === user_id);
  },

  // ---- Blacklist -----------------------------------------------------------
  isBlocked(user_id: string): boolean {
    return blacklist.has(user_id);
  },

  getBlacklist(): string[] {
    return [...blacklist];
  },
};
