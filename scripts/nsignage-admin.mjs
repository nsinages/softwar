#!/usr/bin/env node
// =============================================
// N Signage — staff administration (runs on a staff computer, never on the website)
//
// Needs DATABASE_URL (the nsignage_api pooler connection). Get it once with:
//   npx vercel env pull .env.local        (file is git-ignored)
// then:
//   npm run admin -- create-customer <username> ["Display name"]   (when NSIGNAGE_REGISTRATION=closed)
//   npm run admin -- account <username>
//   npm run admin -- reset-recovery <username>   new recovery key + sign out everywhere
//   npm run admin -- revoke-sessions <username>
//   npm run admin -- disable <username> | enable <username>
//   npm run admin -- device <deviceId>           who owns a Pi
//   npm run admin -- unlink-device <deviceId>    remove a Pi from its account
//
// Password recovery without email: verify the customer OFFLINE first (see
// docs/SUPABASE-SETUP.md §Staff recovery), then run reset-recovery and give
// them the new key in person or by phone. Staff never see or set passwords.
// Every action is recorded in nsignage.security_events.
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

const { asSystem, closeDb } = await import('../api/_lib/db.js');
const { revokeSessions } = await import('../api/_lib/auth.js');
const { newRecoveryKey, hashRecoveryKey, normalizeUsername, validateUsername, hashPassword } = await import('../api/_lib/password.js');
const crypto = await import('node:crypto');

const DEVICE_ID_RX = /^[a-f0-9]{16}$/;
const [cmd, arg, extraArg] = process.argv.slice(2);
const log = (...a) => console.log(...a);
const audit = (action, detail) => console.error(`[audit] ${new Date().toISOString()} ${action} ${JSON.stringify(detail)}`);

class Fail extends Error {}

async function findUser(t) {
  const [u] = await t`select * from nsignage.users where username = ${normalizeUsername(arg)}`;
  if (!u) throw new Fail(`No account named "${arg}"`);
  return u;
}
const event = (t, name, userId, detail, deviceId = null) =>
  t`insert into nsignage.security_events (event, user_id, device_id, detail) values (${name}, ${userId}, ${deviceId}, ${t.json({ by: 'staff-admin-script', ...detail })})`;

try {
  switch (cmd) {
    case 'create-customer': {
      const username = normalizeUsername(arg);
      try { validateUsername(username); } catch (e) { throw new Fail(e.message); }
      const key = newRecoveryKey();
      // Random password nobody knows: the customer chooses their own on /forgot-password with the key
      const unusable = await hashPassword(crypto.randomBytes(48).toString('base64url'));
      const u = await asSystem(async (t) => {
        const [row] = await t`insert into nsignage.users (username, display_name, password_hash, recovery_hash, recovery_created_at)
                              values (${username}, ${extraArg ? String(extraArg).slice(0, 80) : null}, ${unusable}, ${hashRecoveryKey(key)}, now())
                              on conflict (username) do nothing returning id, username`;
        if (!row) throw new Fail(`The username "${username}" is already taken`);
        await event(t, 'staff-create-customer', row.id, {});
        return row;
      });
      audit('create-customer', { user: u.id, username: u.username });
      log(`Account "${u.username}" created.

Give the customer this one-time key (by phone or in person):

  ${key}
`);
      log('They open the website → "Forgot password?" → enter the username and this key → choose their own password.');
      break;
    }
    case 'account': {
      const info = await asSystem(async (t) => {
        const u = await findUser(t);
        const devices = (await t`select id, nickname from nsignage.devices where owner_id = ${u.id}`).map((d) => `${d.id} (${d.nickname || '—'})`);
        const [{ n }] = await t`select count(*)::int as n from nsignage.user_sessions where user_id = ${u.id} and expires_at > now()`;
        return {
          id: u.id, username: u.username, displayName: u.display_name, disabled: u.disabled,
          createdAt: u.created_at.toISOString(), passwordChangedAt: u.password_changed_at.toISOString(),
          devices, activeSessions: n,
        };
      });
      log(info);
      break;
    }
    case 'reset-recovery': {
      const key = newRecoveryKey();
      const r = await asSystem(async (t) => {
        const u = await findUser(t);
        await t`update nsignage.users set recovery_hash = ${hashRecoveryKey(key)}, recovery_created_at = now() where id = ${u.id}`;
        const revoked = await revokeSessions(t, u.id);
        await event(t, 'staff-reset-recovery', u.id, { revoked });
        return { u, revoked };
      });
      audit('reset-recovery', { user: r.u.id, username: r.u.username, revokedSessions: r.revoked });
      log(`New recovery key for "${r.u.username}" (give it to the customer; it is not stored in readable form):\n\n  ${key}\n`);
      log(`${r.revoked} session(s) signed out. The customer now uses "Forgot password?" with this key.`);
      break;
    }
    case 'revoke-sessions': {
      const r = await asSystem(async (t) => {
        const u = await findUser(t);
        const revoked = await revokeSessions(t, u.id);
        await event(t, 'staff-revoke-sessions', u.id, { revoked });
        return { u, revoked };
      });
      audit('revoke-sessions', { user: r.u.id, revoked: r.revoked });
      log(`${r.revoked} session(s) signed out.`);
      break;
    }
    case 'disable':
    case 'enable': {
      const u = await asSystem(async (t) => {
        const user = await findUser(t);
        await t`update nsignage.users set disabled = ${cmd === 'disable'}, account_status = ${cmd === 'disable' ? 'disabled' : 'active'}
                where id = ${user.id}`;
        if (cmd === 'disable') await revokeSessions(t, user.id);
        await event(t, `staff-${cmd}`, user.id, {});
        return user;
      });
      audit(cmd, { user: u.id });
      log(`Account "${u.username}" ${cmd === 'disable' ? 'disabled and signed out' : 'enabled'}.`);
      break;
    }
    case 'device': {
      if (!DEVICE_ID_RX.test(arg || '')) throw new Fail('Device id must be 16 hex characters');
      const [d] = await asSystem((t) => t`select d.id, d.last_seen_at, u.username from nsignage.devices d
                                           left join nsignage.users u on u.id = d.owner_id where d.id = ${arg}`);
      if (!d) throw new Fail('Unknown device id');
      log({ deviceId: d.id, owner: d.username || null, lastSeen: d.last_seen_at.toISOString() });
      break;
    }
    case 'unlink-device': {
      if (!DEVICE_ID_RX.test(arg || '')) throw new Fail('Device id must be 16 hex characters');
      const owner = await asSystem(async (t) => {
        const [d] = await t`select owner_id from nsignage.devices where id = ${arg} for update`;
        if (!d?.owner_id) throw new Fail('This Pi is not registered to any account');
        await t`update nsignage.devices set owner_id = null, added_at = null, added_via = null, nickname = null, location = null
                where id = ${arg}`;
        await event(t, 'staff-unlink-device', d.owner_id, {}, arg);
        return d.owner_id;
      });
      audit('unlink-device', { deviceId: arg, user: owner });
      log('Removed from the account. Files on the Pi are not touched; the customer can add it again.');
      break;
    }
    default:
      log('Usage: npm run admin -- <create-customer|account|reset-recovery|revoke-sessions|disable|enable|device|unlink-device> <username|deviceId>');
      process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  console.error(`Error: ${err instanceof Fail ? err.message : err.reason || err.message}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
