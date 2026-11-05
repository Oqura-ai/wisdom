#!/usr/bin/env node
// The installed `wisdom` command. It imports nothing at load, so an older Node gets this
// message and not a missing-module crash from node:sqlite.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  console.error(`Wisdom needs Node.js 24 or newer. This is ${process.version}.`);
  process.exitCode = 1;
} else {
  await import('./cli.js');
}
