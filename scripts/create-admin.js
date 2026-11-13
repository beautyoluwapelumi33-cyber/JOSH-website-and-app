#!/usr/bin/env node
'use strict';

/**
 * Creates (or promotes) the JOSH administrator account.
 *
 *   JOSH_ADMIN_EMAIL=you@example.com JOSH_ADMIN_PASSWORD='a-long-password' npm run create-admin
 *   npm run create-admin -- --email you@example.com --password 'a-long-password' --name 'JOSH Owner'
 *
 * Never pass a password on a shared machine's shell history in production; prefer
 * the environment variables. No credentials are ever written to the repository.
 */

const path = require('path');
const db = require('../server/db');
const { ensureAdmin } = require('../server/auth');

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

async function main() {
  const email = arg('email', process.env.JOSH_ADMIN_EMAIL || '');
  const password = arg('password', process.env.JOSH_ADMIN_PASSWORD || '');
  const displayName = arg('name', process.env.JOSH_ADMIN_NAME || 'JOSH Owner');

  if (!email) {
    console.error('Missing administrator email. Set JOSH_ADMIN_EMAIL or pass --email.');
    process.exitCode = 1;
    return;
  }

  const file = process.env.JOSH_DB_FILE || path.join(process.env.JOSH_DATA_DIR || '/tmp', 'josh.sqlite');
  await db.open(file);
  try {
    const result = ensureAdmin({ email, password, displayName });
    if (result.created) console.log(`Created administrator ${result.user.email}.`);
    else if (result.promoted) console.log(`Promoted ${result.user.email} to administrator.`);
    else console.log(`${result.user.email} is already an administrator.`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('Could not create the administrator account:', err.message);
  process.exitCode = 1;
});
