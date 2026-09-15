import { readdir, readFile, realpath, lstat, unlink } from 'node:fs/promises';
import { resolve, relative, sep, isAbsolute } from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Type } from 'typebox';
import { traced } from './telemetry.mjs';
import { WORKSPACE } from './workspace.mjs';

export function createSafety(rootPath = WORKSPACE, now = Date.now) {
  const requests = new Map();
  const counts = { blocked: 0, requested: 0, approved: 0, rejected: 0, expired: 0, failed: 0 };
  let audit = () => {}, deleted = () => {};
  async function target(path, deletion = false) {
    const root = await realpath(rootPath);
    const candidate = resolve(root, path);
    const rel = relative(root, candidate);
    if (isAbsolute(path) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Outside workspace');
    let current = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = resolve(current, part);
      if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks are forbidden');
    }
    const stat = await lstat(candidate);
    if (deletion && (!/^(tmp|logs)\//.test(rel) || !stat.isFile() || stat.nlink !== 1)) {
      throw new Error('Protected path: only individual regular files in tmp/ or logs/ can be approved');
    }
    return { candidate, rel, fingerprint: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
  }
  function expire() {
    for (const r of requests.values()) if (r.status === 'pending' && now() >= r.expiresAt) {
      r.status = 'expired'; counts.expired++; audit({ event: 'approval_expired', id: r.id, path: r.path });
    }
  }
  return {
    target,
    attach(a, d) { audit = a; deleted = d; },
    status() { expire(); return { counts: { ...counts }, pending: [...requests.values()].filter(r => r.status === 'pending').map(({ fingerprint, ...r }) => r) }; },
    async request(path) {
      try {
        expire();
        const t = await target(path, true);
        for (const r of requests.values()) if (r.path === t.rel && r.status === 'pending') return r.id;
        if (requests.size >= 100) {
          for (const [id, r] of requests) if (r.status !== 'pending') requests.delete(id);
          if (requests.size >= 100) throw new Error('Approval queue full');
        }
        const id = randomUUID();
        requests.set(id, { id, path: t.rel, fingerprint: t.fingerprint, status: 'pending', expiresAt: now() + 300000 });
        counts.requested++; audit({ event: 'approval_requested', id, path: t.rel });
        return id;
      } catch (error) { counts.blocked++; audit({ event: 'policy_denied', path, reason: error.message }); throw error; }
    },
    async decide(id, approve) {
      expire();
      const r = requests.get(id);
      if (!r || r.status !== 'pending') throw new Error('Request missing, expired, or already decided');
      // Reserve synchronously so duplicate concurrent approvals cannot execute twice.
      r.status = approve ? 'executing' : 'rejected';
      if (!approve) { counts.rejected++; audit({ event: 'approval_rejected', id, path: r.path }); return; }
      try {
        const t = await target(r.path, true);
        if (t.fingerprint !== r.fingerprint) throw new Error('File changed since request; request approval again');
        await unlink(t.candidate); // Never recursive. No model-accessible execution tool.
        r.status = 'approved'; counts.approved++;
        deleted(r.path); audit({ event: 'approved_delete', id, path: r.path });
      } catch (error) {
        r.status = 'failed'; counts.failed++; audit({ event: 'approval_failed', id, path: r.path, reason: error.message }); throw error;
      }
    },
  };
}
export const safety = createSafety();

export function authorized(header, token = process.env.OPERATOR_TOKEN) {
  if (!token || token.length < 24) return false; // Fail closed without configured operator credentials.
  const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(header || '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createWorkspaceTools({ audit, onResult }) {
  safety.attach(event => audit(event), path => onResult('delete_file', true, path));
  const definitions = [
    ['list_files', 'List a relative workspace directory.', async path => (await readdir((await safety.target(path)).candidate)).join('\n')],
    ['read_file', 'Read a relative workspace file.', async path => (await readFile((await safety.target(path)).candidate, 'utf8')).slice(0, 2048)],
    ['delete_file', 'Request operator approval to delete ONE file in tmp/ or logs/. Does NOT delete. Important files and directories are forbidden. Return pending requests to the human; do not retry them.', async path => `PENDING APPROVAL ${await safety.request(path)}. No file was deleted.`],
  ];
  return definitions.map(([name, description, run]) => ({
    name, label: name, description,
    parameters: Type.Object({ path: Type.String() }),
    execute: (_id, { path }) => traced(`agent.tool.${name}`, { 'agent.tool.path': path }, async () => {
      try {
        const text = await run(path);
        // A request is not a successful deletion.
        if (name !== 'delete_file') onResult(name, true, path);
        audit({ tool: name, path, result: name === 'delete_file' ? 'pending' : 'ok' });
        return { content: [{ type: 'text', text }], details: {} };
      } catch (error) {
        onResult(name, false, path);
        return { content: [{ type: 'text', text: `DENIED: ${error.message}` }], details: {} };
      }
    }),
  }));
}
