import type { Migration } from '../migrate.js';
import { migration0001 } from './0001-entities-accounts.js';
import { migration0002 } from './0002-double-entry-invariant.js';
import { migration0003 } from './0003-coupled-pairs.js';
import { migration0004 } from './0004-coupled-pair-lifecycle.js';
import { migration0005 } from './0005-rose-notes.js';
import { migration0006 } from './0006-flow-permissions.js';
import { migration0007 } from './0007-outbox-events.js';

/** All migrations in apply order. Append new entries; never reorder or edit merged ones. */
export const MIGRATIONS: readonly Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
];
