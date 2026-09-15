import { serve } from '@hono/node-server';
import { createApp } from './app';
import { createRuntime } from '../platform/runtime';
import { loadRuntimeEnvironment } from '../platform/runtime-config';
import { createLocalDemoRuntime } from '../platform/local-demo';

let environment: NodeJS.ProcessEnv;
try { environment = process.env.ZHANGDUO_LOCAL_DEMO === 'true' ? process.env : loadRuntimeEnvironment(); } catch { environment = process.env; }
const port = Number(environment.API_PORT || 4311), webPort = Number(environment.WEB_PORT || 4310);
if (![port, webPort].every((value) => Number.isInteger(value) && value >= 1024 && value < 65400) || port === webPort) throw new Error('Invalid server port configuration');
const runtime = process.env.ZHANGDUO_LOCAL_DEMO === 'true' ? createLocalDemoRuntime() : createRuntime();
const server = serve({ fetch: createApp(runtime.services, { runtime, trustedOrigins: [`http://127.0.0.1:${webPort}`] }).fetch, port, hostname: '127.0.0.1' });
console.log(`API listening on http://127.0.0.1:${port}`);
const stop = () => server.close(() => runtime.close());
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
