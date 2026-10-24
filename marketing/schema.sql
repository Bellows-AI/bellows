CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY,created_at TEXT NOT NULL DEFAULT (datetime('now')),name TEXT NOT NULL,email TEXT NOT NULL,company TEXT,team_size TEXT,interest TEXT,message TEXT,consent INTEGER NOT NULL DEFAULT 1,ip_hash TEXT NOT NULL,user_agent TEXT);
CREATE INDEX IF NOT EXISTS leads_created_idx ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS leads_ip_idx ON leads(ip_hash,created_at);
