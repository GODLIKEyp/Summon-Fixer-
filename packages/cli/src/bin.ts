#!/usr/bin/env node
import { runCli } from './cli.js';

runCli(process.argv).catch((err) => {
  console.error('[summon fatal error]', err);
  process.exit(1);
});
