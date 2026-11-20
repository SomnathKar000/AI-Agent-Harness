/**
 * Scripts executed INSIDE the container via node -e.
 * Note: These scripts run inside the container sandbox, never on the host process.
 */
export const STREAMED_READ_SCRIPT = `
const fs = require('node:fs');
const readline = require('node:readline');

if (!fs.existsSync(process.argv[1])) {
  console.error('File not found: ' + process.argv[1]);
  process.exit(1);
}

const rl = readline.createInterface({
  input: fs.createReadStream(process.argv[1]),
  crlfDelay: Infinity,
});

let lineNum = 0;
const lines = [];
const start = parseInt(process.argv[2] || '1', 10);
const end = process.argv[3] ? parseInt(process.argv[3], 10) : Infinity;
let totalBytes = 0;

rl.on('line', (line) => {
  lineNum++;
  if (lineNum >= start && lineNum <= end) {
    totalBytes += Buffer.byteLength(line, 'utf8') + 1;
    if (totalBytes > 200 * 1024) {
      console.error('Requested line slice exceeds 200KB limit.');
      process.exit(2);
    }
    lines.push(line);
  }
  if (lineNum > end) {
    rl.close();
  }
});

rl.on('close', () => {
  process.stdout.write(lines.join('\\n'));
});
`;
