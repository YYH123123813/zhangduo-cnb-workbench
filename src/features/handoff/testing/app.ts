import { Hono } from 'hono';
import { registerRoutes } from '../server';
import { fixtureServices } from './services';
export function appFor(services = fixtureServices()) { const app = new Hono(); registerRoutes(app, services); return app; }
