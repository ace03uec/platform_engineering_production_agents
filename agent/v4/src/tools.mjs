// v4 remediation tools. DELIBERATELY UNSAFE — this is the workshop's safety
// failure mode: no protected-file policy, recursive delete in a "file" tool,
// no dry-run, no approval. Paths cannot escape the disposable workspace. v5 is the fix. Do not copy these into anything real.
import { readdir, readFile, rm, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// Workshop containment is mandatory; business-file protection is absent in v4.
async function targetPath(path, deleting = false) {
  const root = await realpath(WORKSPACE);
  const target = await realpath(resolve(root, path));
  if (target !== root && !target.startsWith(root + sep)) throw new Error('Outside demo workspace');
  if (deleting && target === root) throw new Error('Cannot remove workspace root');
  return target;
}
import { Type } from 'typebox';
import { traced, failed } from './telemetry.mjs';
import { WORKSPACE } from './workspace.mjs';

const PathParams = Type.Object({
  path: Type.String({ description: 'Path relative to /workspace ("" for the workspace root)' }),
});

// audit: (event) => void — structured audit-log sink (one call before
// execution, one after). onResult: (tool, ok, path) => void — metrics sink.
export function createWorkspaceTools({ audit, onResult }) {
  const exec = (name, fn) => (_toolCallId, params) =>
    traced(`agent.tool.${name}`, { 'agent.tool.name': name, 'agent.tool.path': params.path ?? '' }, async span => {
      audit({ tool: name, args: { path: params.path }, decision: 'allowed' });
      try {
        const text = await fn(params);
        audit({ tool: name, args: { path: params.path }, result: 'ok' });
        onResult(name, true, params.path);
        return { content: [{ type: 'text', text }], details: {} };
      } catch (error) {
        failed(span);
        audit({ tool: name, args: { path: params.path }, result: 'error', error: error.message });
        onResult(name, false, params.path);
        return { content: [{ type: 'text', text: `error: ${error.message}` }], details: {} };
      }
    });

  return [
    {
      name: 'list_files',
      label: 'List files',
      description: 'List entries in a workspace directory. Paths are relative to /workspace; use "" for the root. Directory names end with /.',
      promptSnippet: 'list workspace directories',
      parameters: PathParams,
      execute: exec('list_files', async ({ path }) => {
        const entries = await readdir(await targetPath(path ?? ''), { withFileTypes: true });
        if (entries.length === 0) return '(empty)';
        return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
      }),
    },
    {
      name: 'read_file',
      label: 'Read file',
      description: 'Read a workspace file (first 2KB). Paths are relative to /workspace.',
      promptSnippet: 'read workspace files',
      parameters: PathParams,
      execute: exec('read_file', async ({ path }) => {
        const content = await readFile(await targetPath(path), 'utf8');
        return content.slice(0, 2048);
      }),
    },
    {
      name: 'delete_file',
      label: 'Delete file',
      description: 'Permanently delete a workspace file or directory. Paths are relative to /workspace. There is no undo.',
      promptSnippet: 'delete workspace files',
      parameters: PathParams,
      execute: exec('delete_file', async ({ path }) => {
        // BUG (deliberate): no protection for important business files.
        // recursive:true permits directory wipes without approval.
        // The outer workspace boundary is still enforced for lab safety.
        await rm(await targetPath(path, true), { recursive: true });
        return `deleted ${path}`;
      }),
    },
  ];
}
