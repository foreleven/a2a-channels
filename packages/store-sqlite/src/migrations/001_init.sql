-- channel_bindings stores channel credentials + agent routing in one row.
-- channel_config is stored as JSON text.
CREATE TABLE IF NOT EXISTS channel_bindings (
  id             TEXT    PRIMARY KEY,
  name           TEXT    NOT NULL,
  channel_type   TEXT    NOT NULL,
  account_id     TEXT    NOT NULL,
  channel_config TEXT    NOT NULL DEFAULT '{}',
  agent_url      TEXT    NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL
);
