'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const file = process.env.DB_FILE || path.join(__dirname, 'data.db');
const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('client','professional','admin')),
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS professions (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL UNIQUE,
  name_fr TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS professionals (
  user_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  profession_id INTEGER NOT NULL REFERENCES professions(id),
  bio           TEXT    NOT NULL DEFAULT '',
  city          TEXT    NOT NULL DEFAULT '',
  address       TEXT    NOT NULL DEFAULT '',
  price         INTEGER NOT NULL DEFAULT 0,          -- in MAD, 0 = on request
  duration_min  INTEGER NOT NULL DEFAULT 30,
  accepting     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS availability (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  pro_id  INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
  start   TEXT    NOT NULL,
  end     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pro_id     INTEGER NOT NULL REFERENCES professionals(user_id) ON DELETE CASCADE,
  date       TEXT    NOT NULL,
  start      TEXT    NOT NULL,
  end        TEXT    NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','confirmed','declined','cancelled','completed')),
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
-- Backstop against double booking of the same slot
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_slot
  ON bookings(pro_id, date, start) WHERE status IN ('pending','confirmed');
CREATE INDEX IF NOT EXISTS ix_bookings_client ON bookings(client_id, date);
CREATE INDEX IF NOT EXISTS ix_bookings_pro    ON bookings(pro_id, date);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);
`);

const DEFAULT_PROFESSIONS = [
  ['Doctor (General Practitioner)', 'Médecin généraliste'],
  ['Dentist', 'Dentiste'],
  ['Pediatrician', 'Pédiatre'],
  ['Dermatologist', 'Dermatologue'],
  ['Psychologist / Therapist', 'Psychologue / Thérapeute'],
  ['Physiotherapist', 'Kinésithérapeute'],
  ['Veterinarian', 'Vétérinaire'],
  ['Lawyer', 'Avocat'],
  ['Notary', 'Notaire'],
  ['Accountant', 'Expert-comptable'],
  ['Architect', 'Architecte'],
  ['Business Consultant', 'Consultant'],
  ['Private Tutor', 'Professeur particulier'],
  ['Personal Trainer', 'Coach sportif'],
  ['Barber / Hairdresser', 'Coiffeur'],
  ['Beauty & Spa', 'Esthétique & Spa'],
  ['Photographer', 'Photographe'],
  ['Mechanic', 'Mécanicien'],
];
const ins = db.prepare('INSERT OR IGNORE INTO professions (name_en, name_fr) VALUES (?, ?)');
for (const [en, fr] of DEFAULT_PROFESSIONS) ins.run(en, fr);

/** Run fn inside a transaction; rolls back on throw. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { db, tx };
