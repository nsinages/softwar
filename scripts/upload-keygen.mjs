#!/usr/bin/env node
// Staff only: create the Ed25519 key that signs upload tickets.
//   npm run upload:keygen
// Put the PRIVATE value into Vercel → Settings → Environment Variables as
// NSIGNAGE_TICKET_KEY (Production, mark Sensitive). Never commit it, never send it to a Pi.
// Pis learn the PUBLIC key from their authenticated heartbeat.
// Rotation: add the old public key to NSIGNAGE_TICKET_PUBLIC_KEYS, set the new private key,
// redeploy; remove the old public key after 1 hour (longest ticket lifetime).
import { generateTicketKey } from '../api/_lib/tickets.js';

const k = generateTicketKey();
console.log(`NSIGNAGE_TICKET_KEY=${k.privateKeyB64}`);
console.error(`\npublic key (for rotation lists): ${k.publicKey}\nkey id: ${k.kid}\nStore the private value only in Vercel (Sensitive). Do not paste it into chats or tickets.`);
