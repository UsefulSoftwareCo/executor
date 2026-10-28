CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  digest TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('unknown', 'observed')),
  result TEXT
);
