import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSafety, authorized } from './tools.mjs';
import { shutdownTracing } from './telemetry.mjs';

test('policy, approvals, expiry, replay and authentication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'safety-v5-'));
  try {
    for (const dir of ['tmp', 'logs', 'important']) await mkdir(join(root, dir));
    for (const path of ['tmp/a', 'tmp/b', 'tmp/c', 'important/DO_NOT_DELETE.txt']) await writeFile(join(root, path), 'fixture');
    let now = 0;
    const safety = createSafety(root, () => now);
    await assert.rejects(safety.request('important/DO_NOT_DELETE.txt'), /Protected/);
    await assert.rejects(safety.request('tmp'), /Protected/);
    await assert.rejects(safety.request('../elsewhere'), /Outside/);
    await symlink(join(root, 'important/DO_NOT_DELETE.txt'), join(root, 'tmp/link'));
    await assert.rejects(safety.request('tmp/link'), /Symlink/);
    const id = await safety.request('tmp/a');
    assert.equal(await safety.request('tmp/a'), id);
    assert.equal(await readFile(join(root, 'tmp/a'), 'utf8'), 'fixture');
    await safety.decide(id, true);
    await assert.rejects(access(join(root, 'tmp/a')));
    await assert.rejects(safety.decide(id, true), /already decided/);
    const rejected = await safety.request('tmp/b');
    await safety.decide(rejected, false);
    await access(join(root, 'tmp/b'));
    const changed = await safety.request('tmp/b');
    await writeFile(join(root, 'tmp/b'), 'changed content');
    await assert.rejects(safety.decide(changed, true), /changed/);
    const expired = await safety.request('tmp/c');
    now = 300001;
    await assert.rejects(safety.decide(expired, true), /expired/);
    await access(join(root, 'tmp/c'));
    await access(join(root, 'important/DO_NOT_DELETE.txt'));
    const token = 'x'.repeat(32);
    assert.equal(authorized(`Bearer ${token}`, token), true);
    assert.equal(authorized('Bearer wrong', token), false);
    assert.equal(authorized('Bearer short', 'short'), false);
    assert.equal(safety.status().counts.approved, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
    await shutdownTracing();
  }
});
