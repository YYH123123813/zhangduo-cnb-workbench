import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { SCOPES } from '../contracts/scopes';
import { readServerConfig, type ServerConfig } from './cnb/client';

export interface RuntimeConfig { cnb: ServerConfig; connectionKey: string; stateFile: string; scopes: string[]; webPort: number; apiPort: number; reviewCatalogFile?: string }
export type RuntimeConfiguration = { ok: true; data: RuntimeConfig } | { ok: false; missing: string[] };

export function loadRuntimeEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const file = resolve('.env');
  if (!existsSync(file)) return { ...environment };
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 32_000) throw new Error('PRIVATE_ENV_FILE');
    return { ...parseEnv(readFileSync(fd, 'utf8')), ...environment };
  } finally { closeSync(fd); }
}

export function readRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfiguration {
  const required = ['CNB_REPO_SLUG', 'CNB_TOKEN', 'CNB_TOKEN_SCOPES', 'CNB_LIVE_READS_FOR', 'ZHANGDUO_BOOTSTRAP_KEY', 'ZHANGDUO_STATE_FILE', 'ZHANGDUO_APP_SCOPES'];
  const missing = required.filter((key) => !env[key]);
  if (env.ZHANGDUO_MODE !== 'live') missing.push('ZHANGDUO_MODE');
  if (env.ZHANGDUO_STORAGE_CONFIRMED !== 'true') missing.push('ZHANGDUO_STORAGE_CONFIRMED');
  if (missing.length) return { ok: false, missing };
  const cnb = readServerConfig(env);
  if (!cnb.ok) return { ok: false, missing: ['CNB_AUTHORIZED_CONFIGURATION'] };
  const scopes = env.ZHANGDUO_APP_SCOPES!.split(',').map((scope) => scope.trim());
  const valid = z.object({ connectionKey: z.string().regex(/^[a-f0-9]{64}$/), stateFile: z.string().regex(/^\.local\/(live|fixture)\/[A-Za-z0-9_-]+\.sqlite$/),
    scopes: z.array(z.enum(Object.values(SCOPES) as [string, ...string[]])).min(1).max(30), webPort: z.number().int().min(1024).max(65399), apiPort: z.number().int().min(1024).max(65399),
  }).safeParse({ connectionKey: env.ZHANGDUO_BOOTSTRAP_KEY, stateFile: env.ZHANGDUO_STATE_FILE, scopes,
    webPort: Number(env.WEB_PORT || 4310), apiPort: Number(env.API_PORT || 4311) });
  if (!valid.success || new Set(scopes).size !== scopes.length || !scopes.includes('workspace:read')) return { ok: false, missing: ['ZHANGDUO_VALID_CONFIGURATION'] };
  if (valid.data.webPort === valid.data.apiPort) return { ok: false, missing: ['API_PORT', 'WEB_PORT'] };
  if (!['account-profile:r', 'repo-basic-info:r'].every((scope) => cnb.data.tokenScopes.includes(scope) || cnb.data.tokenScopes.includes(scope.replace(/:r$/, ':rw')))) return { ok: false, missing: ['CNB_IDENTITY_READ_SCOPES'] };
  const reviewCatalogFile = env.ZHANGDUO_REVIEW_CATALOG_FILE;
  if (reviewCatalogFile && !/^\.local\/(live|fixture)\/[A-Za-z0-9_-]+\.review\.json$/.test(reviewCatalogFile)) return { ok: false, missing: ['ZHANGDUO_REVIEW_CATALOG_FILE'] };
  return { ok: true, data: { ...valid.data, cnb: cnb.data, ...(reviewCatalogFile ? { reviewCatalogFile } : {}) } };
}
