#!/usr/bin/env node
// CLI for the migration runner: `up`, `down [steps]`, `reset` (down all → up), `verify`
// (up → down → up, proving reversibility). Run via tsx (source) so migrations travel as TS.
import { createPool } from './db.js';
import { hardReset, migrateDown, migrateUp } from './migrate.js';

async function main(): Promise<void> {
  const [command = 'up', arg] = process.argv.slice(2);
  const pool = createPool();
  try {
    switch (command) {
      case 'up': {
        const applied = await migrateUp(pool);
        console.log(`Applied: ${applied.length ? applied.join(', ') : '(none pending)'}`);
        break;
      }
      case 'down': {
        const steps = arg ? Number(arg) : 1;
        const rolled = await migrateDown(pool, steps);
        console.log(`Rolled back: ${rolled.length ? rolled.join(', ') : '(none applied)'}`);
        break;
      }
      case 'reset': {
        await hardReset(pool);
        const applied = await migrateUp(pool);
        console.log(`Reset; applied: ${applied.join(', ')}`);
        break;
      }
      case 'verify': {
        // Forward → down → forward, proving NFR-5 reversibility.
        await hardReset(pool);
        const up1 = await migrateUp(pool);
        const down1 = await migrateDown(pool, up1.length);
        const up2 = await migrateUp(pool);
        if (up1.length !== down1.length || up1.length !== up2.length) {
          throw new Error(
            `Reversibility check failed: up=${up1.length} down=${down1.length} up2=${up2.length}`,
          );
        }
        console.log(`Reversibility OK: up→down→up over ${up1.length} migration(s).`);
        break;
      }
      default:
        throw new Error(`Unknown command '${command}'. Use up | down [steps] | reset | verify.`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
