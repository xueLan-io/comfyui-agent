#!/usr/bin/env node

import { runCli, helpText } from './cli/agent-cli.mjs';

try {
  const result = await runCli(process.argv.slice(2), {
    onProgress: progress => {
      if (progress?.message) process.stderr.write(`${progress.message}\n`);
    },
  });
  const output = typeof result.result?.help === 'string'
    ? result.result.help
    : JSON.stringify(result.result, null, result.json ? 2 : 0);
  process.stdout.write(`${output}\n`);
  process.exitCode = result.exitCode;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.stderr.write(`\n${helpText()}\n`);
  process.exitCode = 2;
}
