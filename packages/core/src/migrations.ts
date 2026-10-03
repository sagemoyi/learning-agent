// core's own tables. Records are stored as validated JSON (`data`) plus the columns we query by.
import type { Migration } from '@learning-agent/contracts'

export const coreMigrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE core_courses (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL
      );

      -- Last content hash core wrote or saw for each course file; a mismatch on read means an outside edit.
      CREATE TABLE core_files (
        course_id TEXT NOT NULL,
        path TEXT NOT NULL,
        hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (course_id, path)
      );

      CREATE TABLE core_changes (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        course_id TEXT,
        target_key TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX core_changes_target ON core_changes (target_key, id);
      CREATE INDEX core_changes_course ON core_changes (course_id, id);

      CREATE TABLE core_sessions (
        session_id TEXT PRIMARY KEY,
        course_id TEXT,
        role TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX core_sessions_course ON core_sessions (course_id, role);

      -- The learning evidence log: append-only.
      CREATE TABLE core_log (
        id TEXT PRIMARY KEY,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        course_id TEXT,
        node_ids TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX core_log_course ON core_log (course_id, at);
      CREATE INDEX core_log_type ON core_log (type, at);
      CREATE TRIGGER core_log_append_only_update BEFORE UPDATE ON core_log
        BEGIN SELECT RAISE(ABORT, 'core_log is append-only'); END;
      CREATE TRIGGER core_log_append_only_delete BEFORE DELETE ON core_log
        BEGIN SELECT RAISE(ABORT, 'core_log is append-only'); END;

      CREATE TABLE core_proposals (
        id TEXT PRIMARY KEY,
        course_id TEXT,
        status TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX core_proposals_course ON core_proposals (course_id, status);
    `,
  },
]
