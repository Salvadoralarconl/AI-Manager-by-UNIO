// Runtime configuration. Everything comes from environment variables so that
// secrets never live in the database, source control, or client responses.
import path from 'node:path';

const env = process.env;

function bool(v, d = false) {
  if (v === undefined || v === '') return d;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== undefined ? n : d;
}

export function loadConfig(overrides = {}) {
  const demo = bool(overrides.DEMO_MODE ?? env.DEMO_MODE);
  const dataDir = path.resolve(overrides.DATA_DIR ?? env.DATA_DIR ?? './data');
  const cfg = {
    demo,
    dataDir,
    // Demo data lives in its own database file so it can never mix with real records.
    dbPath: overrides.DB_PATH ?? env.DB_PATH ?? path.join(dataDir, demo ? 'demo.db' : 'app.db'),
    artifactsDir: overrides.ARTIFACTS_DIR ?? env.ARTIFACTS_DIR ?? path.join(dataDir, demo ? 'demo-projects' : 'projects'),
    host: overrides.HOST ?? env.HOST ?? '127.0.0.1',
    port: num(overrides.PORT ?? env.PORT, 8080),
    ownerPassword: overrides.OWNER_PASSWORD ?? env.OWNER_PASSWORD ?? '',
    sessionSecret: overrides.SESSION_SECRET ?? env.SESSION_SECRET ?? '',
    cookieSecure: bool(overrides.COOKIE_SECURE ?? env.COOKIE_SECURE, false),
    // Provider credentials. Read server-side only; never serialised.
    secrets: {
      openai: overrides.OPENAI_API_KEY ?? env.OPENAI_API_KEY ?? '',
      anthropic: overrides.ANTHROPIC_API_KEY ?? env.ANTHROPIC_API_KEY ?? '',
      local: overrides.LOCAL_AI_API_KEY ?? env.LOCAL_AI_API_KEY ?? '',
    },
    localAiUrl: overrides.LOCAL_AI_URL ?? env.LOCAL_AI_URL ?? '',
    // Paid provider calls stay off until the owner explicitly enables them.
    paidExecution: bool(overrides.PAID_EXECUTION_ENABLED ?? env.PAID_EXECUTION_ENABLED, false),
    runnerTickMs: num(overrides.RUNNER_TICK_MS ?? env.RUNNER_TICK_MS, 1000),
    // Demo runs slowly so work is visible on screen; tests run fast.
    simSpeed: num(overrides.SIM_SPEED ?? env.SIM_SPEED, demo ? 0.05 : 1),
  };
  return cfg;
}

export function providerConfigured(cfg, provider) {
  if (provider === 'simulated') return true;
  if (provider === 'local') return Boolean(cfg.localAiUrl);
  return Boolean(cfg.secrets[provider]);
}

const SECRET_PATTERNS = [/sk-[A-Za-z0-9_\-]{8,}/g, /sk-ant-[A-Za-z0-9_\-]{8,}/g, /Bearer\s+[A-Za-z0-9._\-]{8,}/gi];

// Remove anything that looks like a credential before it reaches logs or clients.
export function redact(value, cfg) {
  let s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return s;
  for (const secret of Object.values(cfg?.secrets ?? {})) {
    if (secret && secret.length >= 6) s = s.split(secret).join('[redacted]');
  }
  if (cfg?.ownerPassword) s = s.split(cfg.ownerPassword).join('[redacted]');
  for (const re of SECRET_PATTERNS) s = s.replace(re, '[redacted]');
  return s;
}
