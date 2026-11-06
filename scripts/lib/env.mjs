// =============================================
// N Signage — the single local secrets file: `.env` in the project root
// (git-ignored). Every script and the dev servers read it through this module.
// Vercel does not read it: deployed values live in Vercel's Environment Variables.
// =============================================
import fs from 'node:fs';
import path from 'node:path';

export const ENV_FILE = path.resolve(process.env.NSIGNAGE_ENV_FILE || '.env');

/** Load KEY=value lines into process.env (values already set in the shell win). Returns false if the file is missing. */
export function loadEnvFile(file = ENV_FILE) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
  }
  return true;
}

/** Set (or add) one KEY=value line in the env file, keeping every other line and comment. Never prints the value. */
export function setEnvValue(key, value, file = ENV_FILE) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${key}=${value}`, '');
  }
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o600 });
}
