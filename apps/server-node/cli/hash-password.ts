import { SCRYPT_PARAMS, hashPassword } from '../src/password-hash.ts';

const SHORT_PASSWORD = 12;

/** Reads a line from a terminal without echoing it. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const { stdin, stderr } = process;
    let value = '';
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();

    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\x04') {
          finish();
          resolve(value);
          return;
        }
        if (char === '\x03') {
          finish();
          reject(new Error('cancelled'));
          return;
        }
        if (char === '\x7f' || char === '\b') {
          value = Array.from(value).slice(0, -1).join('');
        } else if (char === '\x1b') {
          return; // an arrow or function key: its sequence is not part of the password
        } else if (char >= ' ') {
          value += char;
        }
      }
    };
    stdin.on('data', onData);
  });
}

/** The whole of stdin, minus one trailing newline. */
async function readPiped(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

async function main(): Promise<void> {
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden('Password: ');
    if (password !== '' && (await readHidden('Repeat password: ')) !== password) {
      throw new Error('the passwords do not match');
    }
  } else {
    password = await readPiped();
  }
  if (password === '') throw new Error('the password is empty');
  if (Array.from(password).length < SHORT_PASSWORD) {
    process.stderr.write(`warning: a password of at least ${SHORT_PASSWORD} characters is safer\n`);
  }
  process.stdout.write(`${await hashPassword(password)}\n`);
  if (process.stdin.isTTY) {
    process.stderr.write(
      `Parameters: scrypt N=${SCRYPT_PARAMS.N} r=${SCRYPT_PARAMS.r} p=${SCRYPT_PARAMS.p}. ` +
        'Put the value in single quotes in a .env file: it contains $ characters.\n',
    );
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`hash-password: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
