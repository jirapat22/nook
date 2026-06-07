-- Nook Database Schema

-- Journal entries
CREATE TABLE IF NOT EXISTS entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  time_of_day VARCHAR(20),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  is_backdated BOOLEAN DEFAULT FALSE,

  -- Content
  raw_transcript TEXT,
  cleaned_content TEXT,
  user_edited_content TEXT,

  -- AI Analysis
  ai_summary TEXT,
  key_themes JSONB DEFAULT '[]',
  action_items JSONB DEFAULT '[]',
  important_today TEXT,

  -- Mood scores (0-10 scale, null if not detected)
  mood_energy INTEGER,
  mood_happiness INTEGER,
  mood_anxiety INTEGER,
  mood_confidence INTEGER,
  mood_motivation INTEGER,
  mood_social_battery INTEGER,
  mood_physical INTEGER,
  mood_focus INTEGER,
  mood_overall INTEGER,
  mood_source VARCHAR(20),

  -- Metadata
  life_areas JSONB DEFAULT '[]',
  tags JSONB DEFAULT '[]',
  entry_mode VARCHAR(20) DEFAULT 'text',

  -- Love life
  has_love_life_content BOOLEAN DEFAULT FALSE,
  love_life_raw TEXT,
  love_life_cleaned TEXT,
  love_life_emotion_intensity INTEGER,
  love_life_ai_summary TEXT
);

-- People tracker
CREATE TABLE IF NOT EXISTS people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  relationship_type VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  profile_data JSONB DEFAULT '{}'
);

-- Facts/mentions about people extracted from entries
CREATE TABLE IF NOT EXISTS person_mentions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id UUID REFERENCES people(id) ON DELETE CASCADE,
  entry_id UUID REFERENCES entries(id) ON DELETE CASCADE,
  mentioned_at TIMESTAMPTZ DEFAULT NOW(),
  context TEXT,
  sentiment_score INTEGER,
  facts_extracted JSONB DEFAULT '[]',
  emotion_toward VARCHAR(50)
);

-- Offline sync queue
CREATE TABLE IF NOT EXISTS sync_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action VARCHAR(50),
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  synced BOOLEAN DEFAULT FALSE
);

-- App settings
CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR(100) PRIMARY KEY,
  value JSONB
);

-- Insert defaults (won't override existing)
INSERT INTO settings (key, value) VALUES
  ('theme', '"warm-earthy"'),
  ('tts_enabled', 'true'),
  ('tts_speed', '1'),
  ('streak_count', '0'),
  ('last_journal_date', 'null'),
  ('groq_api_key', 'null'),
  ('user_name', '"there"')
ON CONFLICT (key) DO NOTHING;

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date DESC);
CREATE INDEX IF NOT EXISTS idx_entries_mood_overall ON entries(mood_overall);
CREATE INDEX IF NOT EXISTS idx_person_mentions_person ON person_mentions(person_id);
CREATE INDEX IF NOT EXISTS idx_person_mentions_entry ON person_mentions(entry_id);

-- Aliases support (safe to run on existing databases)
ALTER TABLE people ADD COLUMN IF NOT EXISTS aliases JSONB DEFAULT '[]';

-- Photo as a data URL (resized client-side to ~200x200 jpeg, ~10-30KB).
-- Avoids needing object storage for a personal app.
ALTER TABLE people ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- Friend circles / subgroups (free-form text: "Uni gang", "Travel crew").
-- Mostly used for friends but works for any relationship_type.
ALTER TABLE people ADD COLUMN IF NOT EXISTS subgroup TEXT;

-- "Met through" — who introduced you to this person.
-- ON DELETE SET NULL so deleting the introducer doesn't cascade.
ALTER TABLE people ADD COLUMN IF NOT EXISTS introduced_by_id UUID REFERENCES people(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_people_introduced_by ON people(introduced_by_id);

-- Track HOW a mention got linked, so we know which to offer "wrong person?" undo for
-- Values: 'exact', 'alias', 'fuzzy_confirmed', 'auto_scored', 'manual', 'new_person'
ALTER TABLE person_mentions ADD COLUMN IF NOT EXISTS link_method VARCHAR(20);

-- Action item completion state: { "<item text>": 'done' | 'snoozed' | 'dismissed' }
-- Legacy: 'true' boolean → treated as 'done' for backward compat
ALTER TABLE entries ADD COLUMN IF NOT EXISTS action_items_state JSONB DEFAULT '{}';

-- When a snoozed item should resurface: { "<item text>": "YYYY-MM-DD" }
ALTER TABLE entries ADD COLUMN IF NOT EXISTS action_items_snooze_until JSONB DEFAULT '{}';

-- First-person diary summary (e.g. "Today I thought about X, Y, Z").
-- Distinct from ai_summary (short overview) and cleaned_content (verbatim cleanup).
ALTER TABLE entries ADD COLUMN IF NOT EXISTS first_person_summary TEXT;

-- Follow-up reflections appended to the same entry instead of creating a new one.
-- Each item: { text, question, created_at, time_of_day }
ALTER TABLE entries ADD COLUMN IF NOT EXISTS followups JSONB DEFAULT '[]';

-- Full-text search vector + GIN index (covers cleaned content, summary, themes, tags)
ALTER TABLE entries ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_entries_search_vector ON entries USING GIN(search_vector);

-- Trigger to keep search_vector up-to-date
CREATE OR REPLACE FUNCTION entries_search_vector_update() RETURNS trigger AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.ai_summary, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.important_today, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW.key_themes::text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.tags::text, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.cleaned_content, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(NEW.raw_transcript, '')), 'D');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_search_vector_trigger ON entries;
CREATE TRIGGER entries_search_vector_trigger
  BEFORE INSERT OR UPDATE OF ai_summary, important_today, key_themes, tags, cleaned_content, raw_transcript
  ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_search_vector_update();

-- One-time backfill for existing rows where search_vector is NULL
UPDATE entries SET search_vector =
  setweight(to_tsvector('english', coalesce(ai_summary, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(important_today, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(key_themes::text, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(tags::text, '')), 'B') ||
  setweight(to_tsvector('english', coalesce(cleaned_content, '')), 'C') ||
  setweight(to_tsvector('english', coalesce(raw_transcript, '')), 'D')
WHERE search_vector IS NULL;

-- Dedup any pre-existing duplicate (person_id, entry_id) mention rows before
-- enforcing uniqueness below — a race between backfillMentions and an explicit
-- link-mention call (when adding a new person from inside an entry) could
-- create two rows for the same pair. Keep the richer row (a non-backfill link
-- carries AI-extracted sentiment/facts/context) and the earliest on ties.
DELETE FROM person_mentions WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY person_id, entry_id
      ORDER BY (link_method = 'backfill') ASC, mentioned_at ASC, id ASC
    ) AS rn
    FROM person_mentions
  ) ranked WHERE rn > 1
);

-- Guard against the same race going forward: one mention row per person+entry.
CREATE UNIQUE INDEX IF NOT EXISTS idx_person_mentions_unique_person_entry
  ON person_mentions(person_id, entry_id);
