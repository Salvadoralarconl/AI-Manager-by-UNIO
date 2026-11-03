// Local convenience: web + runner in one process. Production runs them separately.
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createServer } from './server.js';
import { Runner, loadAdapters } from './runner.js';

const cfg = loadConfig();
const server = createServer(cfg);
const runner = new Runner({ db: openDb(cfg.dbPath), cfg, adapters: await loadAdapters(cfg) });
server.listen(cfg.port, cfg.host, () => console.log(`[dev] http://${cfg.host}:${cfg.port}${cfg.demo ? ' (DEMO MODE)' : ''}`));
runner.start();
const stop = async () => { await runner.stop(); runner.close(); server.close(); server.closeAllConnections(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
