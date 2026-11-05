// =============================================
// N Signage — Password hashing and recovery keys
//
// Passwords: scrypt (Node core, no native dependency) with a random 16-byte
// salt per hash. Parameters N=2^16, r=8, p=2 are the OWASP-equivalent of
// N=2^17, r=8, p=1 at half the memory (64 MiB per hash). The parameters are
// stored inside every hash, so they can be raised later: logins re-hash old
// parameters automatically (needsRehash).
//
// Recovery keys: 100 random bits, shown to the customer once. Because they
// are high-entropy random values (not human-chosen), a SHA-256 is enough to
// store them; they cannot be brute-forced offline.
// =============================================
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { httpError } from './cloud.js';

const scryptAsync = promisify(crypto.scrypt);

export const SCRYPT = { N: 2 ** 16, r: 8, p: 2, keyLen: 32 };
const MAXMEM = 256 * 1024 * 1024;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// Usernames: 3–32 chars, lowercase letters, digits, ".", "_" and "-",
// starting and ending with a letter or digit. Stored lowercase.
export const USERNAME_RX = /^[a-z0-9](?:[a-z0-9._-]{1,30})[a-z0-9]$/;
const RESERVED = new Set([
  'admin', 'administrator', 'root', 'support', 'help', 'system', 'nsignage', 'n-signage',
  'nsinages', 'n-sinages', 'staff', 'owner', 'security', 'api', 'null', 'undefined',
]);

// A short list of the most common passwords (all ≥ 10 chars, so the length rule doesn't already catch them)
const COMMON = new Set([
  '1234567890', '0123456789', '12345678910', 'qwertyuiop', '1q2w3e4r5t', 'password1', 'password12',
  'password123', 'password1234', 'iloveyou12', 'qwerty1234', 'qwerty12345', '1111111111', '0000000000',
  'abcdefghij', 'abc1234567', 'welcome123', 'admin12345', 'nsignage123', 'letmein123', 'passw0rd123',
]);

export function normalizeUsername(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

export function validateUsername(username) {
  if (!USERNAME_RX.test(username)) {
    throw httpError(400, 'Username must be 3–32 characters: letters, numbers, ".", "_" or "-", starting and ending with a letter or number.', 'bad-username');
  }
  if (RESERVED.has(username)) throw httpError(400, 'This username is reserved. Please choose another.', 'bad-username');
}

export function validatePassword(password, username = '') {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN) {
    throw httpError(400, `Password must be at least ${PASSWORD_MIN} characters.`, 'weak-password');
  }
  if (password.length > PASSWORD_MAX) throw httpError(400, `Password must be at most ${PASSWORD_MAX} characters.`, 'weak-password');
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) throw httpError(400, 'This password is too common. Please choose another.', 'weak-password');
  if (username && lower.includes(username)) throw httpError(400, 'The password must not contain your username.', 'weak-password');
  if (/^(.)\1+$/.test(password)) throw httpError(400, 'This password is too simple. Please choose another.', 'weak-password');
}

async function derive(password, salt, { N, r, p, keyLen }) {
  return scryptAsync(String(password).normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: MAXMEM });
}

/** "scrypt$v1$N$r$p$<salt b64>$<key b64>" */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await derive(password, salt, SCRYPT);
  return ['scrypt', 'v1', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== 'v1') return null;
  const [N, r, p] = parts.slice(2, 5).map(Number);
  if (![N, r, p].every(Number.isSafeInteger) || N < 2 ** 14 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[5], 'base64');
  const key = Buffer.from(parts[6], 'base64');
  if (salt.length < 16 || key.length < 32) return null;
  return { N, r, p, salt, key };
}

// Used when the username does not exist, so the response time does not reveal it.
const DUMMY = `scrypt$v1$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(32).toString('base64')}`;

/** Constant-work check: always runs one scrypt, even for unknown users. */
export async function verifyPassword(password, stored) {
  const h = parseHash(stored) || parseHash(DUMMY);
  const actual = await derive(typeof password === 'string' ? password : '', h.salt, { ...h, keyLen: h.key.length });
  const match = crypto.timingSafeEqual(actual, h.key);
  return match && Boolean(stored) && Boolean(parseHash(stored));
}

export function needsRehash(stored) {
  const h = parseHash(stored);
  return !h || h.N !== SCRYPT.N || h.r !== SCRYPT.r || h.p !== SCRYPT.p;
}

// ---- Recovery keys ----------------------------------------------------------

const B32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

function randomBase32(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += B32[bytes[i] & 31]; // 256 % 32 === 0 → unbiased
  return out;
}

/** 20 chars × 5 bits = 100 bits, shown as XXXX-XXXX-XXXX-XXXX-XXXX. */
export function newRecoveryKey() {
  return randomBase32(20).match(/.{4}/g).join('-');
}

export function normalizeCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function hashRecoveryKey(key) {
  return crypto.createHash('sha256').update(`ns-recovery:${normalizeCode(key)}`).digest('hex');
}

export { randomBase32 };
