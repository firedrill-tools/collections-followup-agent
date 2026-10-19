import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationError, commandMain, invokeCLI, privateDirectory } from './adapter-runtime.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const cases = new Set(JSON.parse(readFileSync(new URL('../datasets/index.json', import.meta.url))).cases.map(item => item.id));
export async function runApplication(input, parameters, signal, invocation) {
  if (Object.keys(input).some(key => !['caseId', 'action', 'task', 'asOf', 'allowWrites'].includes(key)) || !cases.has(input.caseId) || !['run', 'plan'].includes(input.action) ||
      typeof input.task !== 'string' || !input.task.trim() || input.task.length > 8000 || input.task.includes('\0') ||
      typeof input.asOf !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.asOf) || typeof input.allowWrites !== 'boolean') throw new Error('Supply a reviewed case, bounded task, explicit date/action and independent write grant.');
  const directory = await privateDirectory(root, invocation), state = join(directory, 'workspace.json');
  const cli = [process.execPath, 'dist/src/cli.js'];
  try {
    await invokeCLI([...cli, 'init', '--state', state, '--case', input.caseId], { cwd: root, signal });
    const argv = [...cli, 'run', '--state', state, '--task', input.task, '--as-of', input.asOf, '--request-id', randomUUID(), '--output-root', join(directory, 'receipts')];
    if (input.action === 'run') argv.push('--live', '--max-provider-requests', '8');
    if (input.allowWrites) argv.push('--allow-writes');
    if (parameters.model) argv.push('--model', parameters.model);
    return { application: await invokeCLI(argv, { cwd: root, signal }), localState: { directory, workspaceFile: state } };
  } catch (error) { if (error instanceof ApplicationError) error.evidence.runDirectory = directory; throw error; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await commandMain(runApplication);
