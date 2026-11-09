// Pi cloud agent unit tests (Python): repo agent 2.x and the MPV-install agent (V2.1 + merged 2.2).
// Repo agent 2.x: URL and redirect checks, private
// presigned downloads, SHA-256, Range resume, storage, duplicate handling,
// cleanup, identity, and the unchanged LAN upload / player media list.
// The suite itself is tests/helpers/test_cloud_agent_v2.py. Needs Python 3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);

test('Pi agent 2.x download unit tests (Python)', { timeout: 180_000, skip: !python && 'Python not installed' }, () => {
  const r = spawnSync(python, [path.resolve('tests/helpers/test_cloud_agent_v2.py')], { encoding: 'utf8', env: { ...process.env, PYTHONUNBUFFERED: '1' } });
  const summary = (r.stdout || '').trim().split('\n').pop();
  assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`.slice(-6000));
  const s = JSON.parse(summary);
  assert.equal(s.failures + s.errors, 0);
  assert.ok(s.tests >= 20, `ran ${s.tests} tests`);
});

// MPV-install agent (the Pi's real cloud agent): the installed 2.0-ns1 ("V2.1") and the merged 2.2-ns1
for (const file of ['cloud_agent_v2.1.py']) {
  test(`MPV agent ${file}: shared V2.1 behaviour (installed V2.1, unchanged) (Python)`, { timeout: 180_000, skip: !python && 'Python not installed' }, () => {
    const r = spawnSync(python, [path.resolve('tests/helpers/test_mpv_agent.py')], {
      encoding: 'utf8', env: { ...process.env, AGENT_FILE: path.resolve('N-Signage/mpv-agent', file), PYTHONUNBUFFERED: '1' },
    });
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`.slice(-6000));
    const s = JSON.parse((r.stdout || '').trim().split('\n').pop());
    assert.equal(s.failures + s.errors, 0);
    assert.ok(s.tests - s.skipped >= 15, `ran ${s.tests - s.skipped} tests`);
  });
}
