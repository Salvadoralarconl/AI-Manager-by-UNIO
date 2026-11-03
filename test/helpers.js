import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { openDb, setSetting } from '../src/db.js';
import * as S from '../src/store.js';
import { Runner } from '../src/runner.js';
import { create as createSimulated } from '../src/workers/simulated.js';
import { unavailableAdapter } from '../src/workers/adapter.js';

export function setup(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-test-'));
  const cfg = loadConfig({ DATA_DIR: dir, SIM_SPEED: '200', DEMO_MODE: '0', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', LOCAL_AI_URL: '', OWNER_PASSWORD: '', ...overrides });
  const db = openDb(path.join(dir, 'test.db'));
  setSetting(db, 'global_concurrency', 10);
  const sim = createSimulated(cfg);
  const adapters = { simulated: sim, openai: unavailableAdapter('openai', 'n/a'), anthropic: unavailableAdapter('anthropic', 'n/a'), local: unavailableAdapter('local', 'n/a') };
  const runner = new Runner({ db, cfg, adapters, id: 'runner_test' });
  const mk = (role, extra = {}) => S.createAgent(db, { role, provider: 'simulated', ...extra });
  return { dir, cfg, db, runner, adapters, mk, S };
}

// Tick the runner and wait for in-flight runs until nothing changes.
export async function settle(runner, max = 40) {
  for (let i = 0; i < max; i++) {
    await runner.tick();
    if (!runner.active.size) {
      const open = runner.db.prepare("SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.status = 'active' AND t.state IN ('queued','running','awaiting_review')").get().n;
      if (!open) return;
      // If nothing is running and nothing could start, stop.
      await runner.tick();
      if (!runner.active.size) return;
    }
    await runner.drain();
  }
}

export function events(db, type) {
  return db.prepare('SELECT * FROM events WHERE type = ? ORDER BY id').all(type);
}
