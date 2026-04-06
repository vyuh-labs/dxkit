#!/usr/bin/env node

import { run } from './cli';

run(process.argv).catch((err: Error) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
