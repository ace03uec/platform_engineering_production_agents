import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'agent-v4-test-'));
process.env.WORKSPACE_DIR = join(root, 'workspace');
const { seedWorkspace, countFiles, WORKSPACE } = await import('./workspace.mjs');
const { createWorkspaceTools } = await import('./tools.mjs');
const { shutdownTracing } = await import('./telemetry.mjs');

test('unsafe business-file deletion is real; workspace escape remains blocked', async () => {
  try {
    await seedWorkspace();
    assert.equal(await countFiles(), 6);
    const events = [];
    const tools = createWorkspaceTools({ audit: e => events.push(e), onResult: () => {} });
    const del = tools.find(t => t.name === 'delete_file');
    await del.execute('test', { path: 'important/DO_NOT_DELETE.txt' });
    await assert.rejects(access(join(WORKSPACE, 'important/DO_NOT_DELETE.txt')));
    assert.equal(await countFiles(), 5);
    assert.ok(events.some(e => e.result === 'ok'));
    const traversal = await del.execute('test', { path: '..' });
    assert.match(traversal.content[0].text, /Outside demo workspace/);
    await symlink(root, join(WORKSPACE, 'escape'));
    const escaped = await del.execute('test', { path: 'escape' });
    assert.match(escaped.content[0].text, /Outside demo workspace/);
    const wipe = await del.execute('test', { path: '' });
    assert.match(wipe.content[0].text, /Cannot remove workspace root/);
    await seedWorkspace(true);
    await access(join(WORKSPACE, 'important/DO_NOT_DELETE.txt'));
  } finally {
    await shutdownTracing();
    await rm(root, { recursive: true, force: true });
  }
});
