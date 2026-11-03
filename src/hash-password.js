// Prints an OWNER_PASSWORD_HASH value (scrypt) and nothing else on stdout.
//   node src/hash-password.js            prompts (input hidden when run in a terminal)
//   node src/hash-password.js 'secret'   non-interactive (ends up in shell history)
import readline from 'node:readline';
import { hashPassword } from './auth.js';

async function ask() {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.split(/\r?\n/)[0];
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = (s) => { if (s.includes('Password')) process.stderr.write(s); };
  const pw = await new Promise((r) => rl.question('Password: ', r));
  rl.close();
  process.stderr.write('\n');
  return pw;
}

const pw = process.argv[2] ?? (await ask());
if (!pw || pw.length < 8) {
  console.error('Use a password of at least 8 characters.');
  process.exit(1);
}
console.log(hashPassword(pw));
