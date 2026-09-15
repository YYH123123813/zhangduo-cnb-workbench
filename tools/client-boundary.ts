import type { Plugin } from 'vite';

export function assertClientEnvironment(env: Record<string, unknown>): void {
  if (Object.entries(env).some(([key, value]) => value && /^VITE_.*(TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY)/i.test(key))) throw new Error('Client-exposed secret configuration is forbidden');
}

export function assertClientModule(id: string): void {
  const path = id.replaceAll('\\', '/').split('?')[0] ?? '';
  if (/\/src\/(platform|server)\//.test(path) || /\/src\/features\/[^/]+\/server\.[cm]?[jt]sx?$/.test(path)) throw new Error('Server implementation cannot enter the client module graph');
}

export function privateDevPath(url: string): boolean {
  let path: string;
  try { path = decodeURIComponent(url.split('?')[0] ?? '').replaceAll('\\', '/'); } catch { return true; }
  return /(?:^|\/)(?:\.local|\.git|\.env(?:\.[^/]*)?)(?:\/|$)/i.test(path)
    || /\.sqlite(?:-wal|-shm)?(?:\/|$)/i.test(path) || /\/src\/(?:platform|server)(?:\/|$)/.test(path);
}

export function clientBoundary(): Plugin {
  return { name: 'zhangduo-client-boundary', enforce: 'pre',
    configResolved(config) { assertClientEnvironment(config.env); },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!privateDevPath(request.url ?? '')) return next();
        response.statusCode = 403;
        response.setHeader('Cache-Control', 'no-store');
        response.end('Forbidden');
      });
    },
    transform(_source, id) { assertClientModule(id); return null; },
  };
}
