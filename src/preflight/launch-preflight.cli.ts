/** MVP-3 offline launch-preflight CLI. Reads only env names/presence and
 * `migrations/` filenames; prints one JSON report. No network, no `.env`.
 * Exit codes: 0 pass, 1 check failures, 2 unexpected usage/runtime error. */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { runLaunchPreflight } from './launch-preflight';

const REPO_ROOT = resolve(__dirname, '..', '..');
const USAGE = 'usage: pnpm preflight:launch (no arguments)';

export function runCli(argv: readonly string[]): number {
  if (argv.length > 0) {
    process.stderr.write(`preflight: unexpected arguments. ${USAGE}\n`);
    return 2;
  }
  const migrationFilenames = readdirSync(resolve(REPO_ROOT, 'migrations'));
  const report = runLaunchPreflight({ env: process.env, migrationFilenames });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

try {
  process.exitCode = runCli(process.argv.slice(2));
} catch (error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  process.stderr.write(`preflight: unexpected runtime error: ${message}\n`);
  process.exitCode = 2;
}
