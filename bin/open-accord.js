#!/usr/bin/env node
// node:sqlite prints an "experimental" warning on stderr; it is noise for people and agents reading our output.
process.removeAllListeners('warning')
const { main } = await import('../src/cli.js')
main(process.argv.slice(2))
