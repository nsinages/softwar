#!/usr/bin/env node
// =============================================
// Staff only: create the Cloudflare Tunnel + DNS name for ONE Pi's upload receiver.
//
//   node scripts/provision-tunnel.mjs --device <deviceId>            dry run (prints the plan, calls nothing)
//   node scripts/provision-tunnel.mjs --device <deviceId> --apply    creates tunnel, ingress, DNS; writes the token file
//
// Env (staff PC only; never in Vercel, never on a Pi):
//   CF_API_TOKEN   scoped API token: Account › Cloudflare Tunnel › Edit, Zone › DNS › Edit (nsinages.in only)
//   CF_ACCOUNT_ID, CF_ZONE_ID
//
// Result: hostname p-<16 random hex>.nsinages.in (first-level → free Universal SSL; random, so device ids
// are not exposed), a remotely managed tunnel whose ONLY ingress is that hostname → http://127.0.0.1:8090
// (everything else 404), a proxied CNAME to <tunnel>.cfargotunnel.com, and ./tunnel-<deviceId>.token
// (mode 0600) to pipe into install-upload-receiver.sh on that Pi, then delete.
// =============================================
import crypto from 'node:crypto';
import fs from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const DOMAIN = process.env.NSIGNAGE_RECEIVER_DOMAIN || 'nsinages.in';

export function plan(deviceId, label = crypto.randomBytes(8).toString('hex')) {
  if (!/^[a-f0-9]{16}$/.test(deviceId)) throw new Error('--device must be the 16-hex device id');
  const hostname = `p-${label}.${DOMAIN}`;
  return {
    hostname,
    tunnelName: `nsignage-${deviceId}`,
    ingress: [
      { hostname, service: 'http://127.0.0.1:8090', originRequest: { connectTimeout: 10, noTLSVerify: false } },
      { service: 'http_status:404' },
    ],
  };
}

export async function apply(p, { token, accountId, zoneId, fetchImpl = fetch }) {
  const call = async (method, path, body) => {
    const r = await fetchImpl(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body && { body: JSON.stringify(body) }),
    });
    const j = await r.json();
    if (!j.success) throw new Error(`${method} ${path.replace(/[a-f0-9]{32}/g, '…')} failed: ${JSON.stringify(j.errors || r.status)}`);
    return j.result;
  };
  const tunnel = await call('POST', `/accounts/${accountId}/cfd_tunnel`, { name: p.tunnelName, config_src: 'cloudflare' });
  await call('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress: p.ingress } });
  await call('POST', `/zones/${zoneId}/dns_records`, {
    type: 'CNAME', name: p.hostname, content: `${tunnel.id}.cfargotunnel.com`, proxied: true, ttl: 1, comment: `N-Signage upload receiver (${p.tunnelName})`,
  });
  const tunnelToken = await call('GET', `/accounts/${accountId}/cfd_tunnel/${tunnel.id}/token`);
  return { tunnelId: tunnel.id, tunnelToken };
}

async function main() {
  const args = process.argv.slice(2);
  const deviceId = args[args.indexOf('--device') + 1] || '';
  const p = plan(deviceId);
  console.log(JSON.stringify({ hostname: p.hostname, tunnel: p.tunnelName, ingress: p.ingress }, null, 2));
  if (!args.includes('--apply')) {
    console.log('\nDry run only. Re-run with --apply to create it in Cloudflare.');
    return;
  }
  const { CF_API_TOKEN: token, CF_ACCOUNT_ID: accountId, CF_ZONE_ID: zoneId } = process.env;
  if (!token || !accountId || !zoneId) throw new Error('Set CF_API_TOKEN, CF_ACCOUNT_ID and CF_ZONE_ID');
  const { tunnelId, tunnelToken } = await apply(p, { token, accountId, zoneId });
  const file = `tunnel-${deviceId}.token`;
  fs.writeFileSync(file, `${tunnelToken}\n`, { mode: 0o600 });
  console.log(`\nTunnel ${tunnelId} created. Token written to ./${file} (0600). On the Pi:\n  sudo ./install-upload-receiver.sh --hostname ${p.hostname} < ${file}\nthen delete the token file.`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((err) => { console.error(`ERROR: ${err.message}`); process.exit(1); });
}
