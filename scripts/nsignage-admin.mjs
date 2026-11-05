#!/usr/bin/env node
// =============================================
// N Signage — staff administration (runs on a staff computer, never on the website)
//
// Needs the production Redis credentials. Get them once with:
//   npx vercel env pull .env.local        (file is git-ignored)
// then:
//   node scripts/nsignage-admin.mjs account <username>
//   node scripts/nsignage-admin.mjs reset-recovery <username>   new recovery key + sign out everywhere
//   node scripts/nsignage-admin.mjs revoke-sessions <username>
//   node scripts/nsignage-admin.mjs disable <username> | enable <username>
//   node scripts/nsignage-admin.mjs device <deviceId>           who owns a Pi
//   node scripts/nsignage-admin.mjs unlink-device <deviceId>    remove a Pi from its account
//
// Password recovery without email: verify the customer OFFLINE first (see
// docs/ACCOUNTS-AND-TRANSFERS.md §Recovery), then run reset-recovery and give
// them the new key in person or by phone. They set a new password with it on
// the website ("Forgot password?"). Staff never see or set passwords.
// =============================================
import fs from 'node:fs';
import path from 'node:path';

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
}
loadEnvFile(path.resolve('.env.local'));

const { redis, keys, DEVICE_ID_RX } = await import('../api/_lib/cloud.js');
const { getUserByUsername, saveUser, revokeSessions, deviceOwnerId, getUser } = await import('../api/_lib/auth.js');
const { newRecoveryKey, hashRecoveryKey, normalizeUsername } = await import('../api/_lib/password.js');

const [cmd, arg] = process.argv.slice(2);
const log = (...a) => console.log(...a);
const fail = (msg) => { console.error(`Error: ${msg}`); process.exit(1); };
const audit = (action, detail) => console.error(`[audit] ${new Date().toISOString()} ${action} ${JSON.stringify(detail)}`);

async function userArg() {
  const user = await getUserByUsername(normalizeUsername(arg));
  if (!user) fail(`No account named "${arg}"`);
  return user;
}

switch (cmd) {
  case 'account': {
    const u = await userArg();
    const devices = Object.keys((await redis().hgetall(keys.userDevices(u.id))) || {});
    const sessions = ((await redis().smembers(keys.userSessions(u.id))) || []).length;
    log({
      id: u.id, username: u.username, displayName: u.displayName, disabled: Boolean(u.disabled),
      createdAt: new Date(u.createdAt).toISOString(),
      passwordChangedAt: u.passwordChangedAt && new Date(u.passwordChangedAt).toISOString(),
      devices, sessionsIndexed: sessions,
    });
    break;
  }
  case 'reset-recovery': {
    const u = await userArg();
    const key = newRecoveryKey();
    u.recoveryHash = hashRecoveryKey(key);
    u.recoveryKeyCreatedAt = Date.now();
    await saveUser(u);
    const revoked = await revokeSessions(u.id);
    audit('reset-recovery', { user: u.id, username: u.username, revokedSessions: revoked });
    log(`New recovery key for "${u.username}" (give it to the customer, it is not stored in readable form):\n\n  ${key}\n`);
    log(`${revoked} session(s) signed out. The customer now uses "Forgot password?" with this key.`);
    break;
  }
  case 'revoke-sessions': {
    const u = await userArg();
    const n = await revokeSessions(u.id);
    audit('revoke-sessions', { user: u.id, revoked: n });
    log(`${n} session(s) signed out.`);
    break;
  }
  case 'disable':
  case 'enable': {
    const u = await userArg();
    u.disabled = cmd === 'disable';
    await saveUser(u);
    if (u.disabled) await revokeSessions(u.id);
    audit(cmd, { user: u.id });
    log(`Account "${u.username}" ${u.disabled ? 'disabled and signed out' : 'enabled'}.`);
    break;
  }
  case 'device': {
    if (!DEVICE_ID_RX.test(arg || '')) fail('Device id must be 16 hex characters');
    const owner = await deviceOwnerId(arg);
    const u = owner ? await getUser(owner) : null;
    log({ deviceId: arg, owner: u ? u.username : null });
    break;
  }
  case 'unlink-device': {
    if (!DEVICE_ID_RX.test(arg || '')) fail('Device id must be 16 hex characters');
    const owner = await deviceOwnerId(arg);
    if (!owner) fail('This Pi is not registered to any account');
    await redis().hdel(keys.userDevices(owner), arg);
    await redis().del(keys.deviceOwner(arg));
    audit('unlink-device', { deviceId: arg, user: owner });
    log('Removed from the account. Files on the Pi are not touched; the customer can add it again.');
    break;
  }
  default:
    log('Usage: node scripts/nsignage-admin.mjs <account|reset-recovery|revoke-sessions|disable|enable|device|unlink-device> <username|deviceId>');
    process.exit(cmd ? 1 : 0);
}
