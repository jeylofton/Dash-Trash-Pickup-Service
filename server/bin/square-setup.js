/* ============================================================
   One-time Square setup.

     node bin/square-setup.js --env=sandbox
     node bin/square-setup.js --env=production
     node bin/square-setup.js --env=sandbox --dry-run

   Creates the four subscription plans in your Square catalog and
   writes their variation IDs back into the matching .env file.

   Safe to re-run. Plans are matched by name, so a second run
   reuses what already exists instead of creating duplicates.
   ============================================================ */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = join(HERE, '..');

/* ---------- arguments ---------- */

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const target = [...args].find(a => a.startsWith('--env='))?.split('=')[1];

if (target !== 'sandbox' && target !== 'production') {
  console.error(`
  Usage: node bin/square-setup.js --env=sandbox|production [--dry-run]

    --env=sandbox      configure server/.env            (test money)
    --env=production   configure server/.env.production (real money)
    --dry-run          show what would happen, change nothing
`);
  process.exit(1);
}

const ENV_FILE = join(SERVER_ROOT, target === 'sandbox' ? '.env' : '.env.production');

if (!existsSync(ENV_FILE)) {
  const example = target === 'sandbox' ? '.env.example' : '.env.production.example';
  console.error(`
  ${ENV_FILE} does not exist.

    cp ${example} ${target === 'sandbox' ? '.env' : '.env.production'}

  Then paste your ${target} access token into SQUARE_ACCESS_TOKEN and re-run.
`);
  process.exit(1);
}

/* Load the chosen file into process.env BEFORE importing square.js, which
   captures its credentials at module load. `override` matters because a
   previous `.env` may already be in the environment. */
dotenv.config({ path: ENV_FILE, override: true });
process.env.SQUARE_ENVIRONMENT = target;

const { squareFetch, SquareError, idempotencyKey } =
  await import('../lib/payments/square.js');

/* ---------- plan definitions ----------
   Prices mirror CONFIG.pricing in scripts.js. Edit them there and here
   together, or Square will charge something the site never showed. */

const MONTHLY = 28;
const QUARTERLY = MONTHLY * 3 - 10;     // 74
const ANNUAL = MONTHLY * 12 - 60;       // 276
const INTRO = 18;
const INTRO_TERM_MONTHS = 12;

const usd = (dollars) => ({ amount: Math.round(dollars * 100), currency: 'USD' });
const staticPhase = (ordinal, cadence, dollars, periods) => ({
  ordinal,
  cadence,
  ...(periods ? { periods } : {}),
  pricing: { type: 'STATIC', price_money: usd(dollars) },
});

const PLANS = [
  {
    envKey: 'SQUARE_PLAN_INTRODUCTORY',
    planCode: 'Introductory',
    name: 'Dash Trash Pickup - Introductory Rate',
    variationName: 'Introductory Rate',
    // $18/mo for the first 12 months, then the standard $28/mo forever.
    phases: [
      staticPhase(0, 'MONTHLY', INTRO, INTRO_TERM_MONTHS),
      staticPhase(1, 'MONTHLY', MONTHLY),
    ],
    summary: `$${INTRO}/mo for ${INTRO_TERM_MONTHS} months, then $${MONTHLY}/mo`,
  },
  {
    envKey: 'SQUARE_PLAN_MONTHLY',
    planCode: 'Monthly',
    name: 'Dash Trash Pickup - Monthly',
    variationName: 'Monthly',
    phases: [staticPhase(0, 'MONTHLY', MONTHLY)],
    summary: `$${MONTHLY}/mo`,
  },
  {
    envKey: 'SQUARE_PLAN_QUARTERLY',
    planCode: 'Quarterly',
    name: 'Dash Trash Pickup - Quarterly',
    variationName: 'Quarterly',
    phases: [staticPhase(0, 'QUARTERLY', QUARTERLY)],
    summary: `$${QUARTERLY} every 3 months`,
  },
  {
    envKey: 'SQUARE_PLAN_ANNUAL',
    planCode: 'Annual',
    name: 'Dash Trash Pickup - Annual',
    variationName: 'Annual',
    phases: [staticPhase(0, 'ANNUAL', ANNUAL)],
    summary: `$${ANNUAL}/year`,
  },
];

/* ---------- catalog helpers ---------- */

/** Every SUBSCRIPTION_PLAN on the account, keyed by name. */
async function fetchExistingPlans() {
  const data = await squareFetch('/v2/catalog/search', {
    body: { object_types: ['SUBSCRIPTION_PLAN'], include_deleted_objects: false },
  });
  const byName = new Map();
  for (const obj of data.objects || []) {
    const name = obj.subscription_plan_data?.name;
    if (name) byName.set(name, obj);
  }
  return byName;
}

/** Square has returned variations embedded and, in other versions, as separate
 *  objects. Handle both rather than betting on one shape. */
async function variationIdFor(planObject, variationName) {
  const embedded = planObject.subscription_plan_data?.subscription_plan_variations || [];
  if (embedded.length) {
    const match = embedded.find(
      v => v.subscription_plan_variation_data?.name === variationName
    );
    return (match || embedded[0]).id;
  }

  const data = await squareFetch('/v2/catalog/search', {
    body: { object_types: ['SUBSCRIPTION_PLAN_VARIATION'], include_deleted_objects: false },
  });
  const match = (data.objects || []).find(
    v => v.subscription_plan_variation_data?.subscription_plan_id === planObject.id
  );
  return match?.id || null;
}

async function createPlan(plan) {
  const data = await squareFetch('/v2/catalog/object', {
    body: {
      idempotency_key: idempotencyKey(),
      object: {
        type: 'SUBSCRIPTION_PLAN',
        id: '#plan',
        subscription_plan_data: {
          name: plan.name,
          subscription_plan_variations: [{
            type: 'SUBSCRIPTION_PLAN_VARIATION',
            id: '#variation',
            subscription_plan_variation_data: {
              name: plan.variationName,
              phases: plan.phases,
            },
          }],
        },
      },
    },
  });
  return data.catalog_object;
}

/* ---------- .env writing ---------- */

/** Replace KEY=... in place, preserving comments and ordering. Appends the
 *  key only when the file does not already mention it. */
function writeEnvValues(file, values) {
  let text = readFileSync(file, 'utf8');
  const appended = [];

  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    if (pattern.test(text)) text = text.replace(pattern, line);
    else appended.push(line);
  }

  if (appended.length) {
    text = text.replace(/\n*$/, '\n') + appended.join('\n') + '\n';
  }
  writeFileSync(file, text);
}

/* ---------- SQLite ----------
   plans.provider_plan_id holds one environment's IDs at a time, so only write
   it when this target is the environment the server actually runs as. */
async function writePlanIdsToDb(resolved) {
  const active = readActiveEnvironment();
  if (active !== target) {
    console.log(`  - skipped plans.provider_plan_id (server runs as "${active}", not "${target}")`);
    return;
  }
  try {
    const { run } = await import('../db/index.js');
    for (const [planCode, variationId] of Object.entries(resolved)) {
      run('UPDATE plans SET provider_plan_id = ? WHERE code = ?', variationId, planCode);
    }
    console.log('  - plans.provider_plan_id updated in SQLite');
  } catch (err) {
    console.warn(`  ! could not update SQLite: ${err.message}`);
    console.warn('    The .env values are what the server reads, so checkout still works.');
  }
}

function readActiveEnvironment() {
  const dotEnv = join(SERVER_ROOT, '.env');
  if (!existsSync(dotEnv)) return 'sandbox';
  const match = readFileSync(dotEnv, 'utf8').match(/^SQUARE_ENVIRONMENT=(.*)$/m);
  return (match?.[1] || 'sandbox').trim() === 'production' ? 'production' : 'sandbox';
}

/* ---------- main ---------- */

console.log(`\n  Square setup - ${target}${DRY_RUN ? '  (dry run)' : ''}`);
console.log(`  env file: ${ENV_FILE}\n`);

if (!process.env.SQUARE_ACCESS_TOKEN || process.env.SQUARE_ACCESS_TOKEN.includes('...')) {
  console.error(`  SQUARE_ACCESS_TOKEN is not set in ${ENV_FILE}.

  Get it from https://developer.squareup.com/apps -> your app -> Credentials
  (${target === 'sandbox' ? 'Sandbox' : 'Production'} tab). Paste it in yourself, then re-run.\n`);
  process.exit(1);
}

try {
  /* 1. credentials */
  const { locations = [] } = await squareFetch('/v2/locations', { method: 'GET' });
  if (!locations.length) {
    console.error('  This account has no locations. Create one in the Square Dashboard first.\n');
    process.exit(1);
  }

  let locationId = process.env.SQUARE_LOCATION_ID;
  const known = locations.find(l => l.id === locationId);
  if (!known) {
    locationId = locations[0].id;
    console.log(`  Location: ${locations[0].name} (${locationId})  <- auto-selected`);
  } else {
    console.log(`  Location: ${known.name} (${locationId})`);
  }
  console.log(`  Credentials OK - ${locations.length} location(s)\n`);

  /* 2. plans */
  const existing = await fetchExistingPlans();
  const envValues = { SQUARE_LOCATION_ID: locationId };
  const resolved = {};

  for (const plan of PLANS) {
    const found = existing.get(plan.name);

    if (found) {
      const variationId = await variationIdFor(found, plan.variationName);
      if (!variationId) {
        console.log(`  ! ${plan.planCode.padEnd(13)} plan exists but has no variation - delete it in Square and re-run`);
        continue;
      }
      console.log(`  = ${plan.planCode.padEnd(13)} reused    ${variationId}   ${plan.summary}`);
      envValues[plan.envKey] = variationId;
      resolved[plan.planCode] = variationId;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  + ${plan.planCode.padEnd(13)} would create         ${plan.summary}`);
      continue;
    }

    const created = await createPlan(plan);
    const variationId = await variationIdFor(created, plan.variationName);
    console.log(`  + ${plan.planCode.padEnd(13)} created   ${variationId}   ${plan.summary}`);
    envValues[plan.envKey] = variationId;
    resolved[plan.planCode] = variationId;
  }

  /* 3. write back */
  if (DRY_RUN) {
    console.log('\n  Dry run - nothing written.\n');
    process.exit(0);
  }

  console.log('');
  writeEnvValues(ENV_FILE, envValues);
  console.log(`  - wrote ${Object.keys(envValues).length} values to ${ENV_FILE}`);
  await writePlanIdsToDb(resolved);

  const missing = PLANS.filter(p => !envValues[p.envKey]).map(p => p.planCode);
  if (missing.length) {
    console.log(`\n  ! Still unresolved: ${missing.join(', ')}\n`);
    process.exit(1);
  }

  console.log(`
  Done.

  Next:
    ${target === 'sandbox'
      ? 'npm start   then run a test signup with card 4111 1111 1111 1111'
      : 'set SQUARE_ENVIRONMENT=production in .env and copy the production credentials across'}
`);

} catch (err) {
  if (err instanceof SquareError) {
    console.error(`\n  Square rejected ${err.endpoint} (HTTP ${err.status}):`);
    for (const e of err.errors) console.error(`    [${e.code}] ${e.detail || e.category}`);
    if (err.errors.some(e => e.code === 'UNAUTHORIZED' || e.code === 'AUTHENTICATION_ERROR')) {
      console.error(`\n  The token in ${ENV_FILE} is not a valid ${target} token.`);
      console.error('  Sandbox and production tokens are not interchangeable.');
    }
    console.error('');
    process.exit(1);
  }
  console.error('\n ', err, '\n');
  process.exit(1);
}
