import net from 'node:net';
import { spawn } from 'node:child_process';

async function available(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

let webPort = Number(process.env.WEB_PORT || 4310);
let apiPort = Number(process.env.API_PORT || webPort + 1);
if (![webPort, apiPort].every((port) => Number.isInteger(port) && port > 0 && port < 65400)) {
  throw new Error('WEB_PORT and API_PORT must be valid ports below 65400');
}
let attempts = 0;
while (!(await available(webPort)) || !(await available(apiPort)) || webPort === apiPort) {
  if (++attempts >= 50) throw new Error('No free local port pair found');
  webPort += 2;
  apiPort = webPort + 1;
}
const env = { ...process.env, WEB_PORT: String(webPort), API_PORT: String(apiPort) };
const children = [
  spawn('pnpm', ['dev:api'], { stdio: 'inherit', env }),
  spawn('pnpm', ['dev:web'], { stdio: 'inherit', env }),
];
console.log(`Web: http://127.0.0.1:${webPort}\nAPI: http://127.0.0.1:${apiPort}`);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; stop(); });
  child.on('exit', (code) => { if (!stopping) { process.exitCode = code || 1; stop(); } });
}
