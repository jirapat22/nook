require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db/db');

const entriesRouter = require('./routes/entries');
const aiRouter = require('./routes/ai');
const insightsRouter = require('./routes/insights');
const peopleRouter = require('./routes/people');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Settings API (simple CRUD on the settings table)
app.get('/api/settings', async (req, res) => {
  try {
    const result = await db.query('SELECT key, value FROM settings');
    const settings = {};
    result.rows.forEach(row => { settings[row.key] = row.value; });
    res.json(settings);
  } catch (err) {
    console.error('GET /api/settings error:', err);
    res.status(500).json({ error: 'Failed to load settings', code: 'DB_ERROR' });
  }
});

app.put('/api/settings/:key', async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  try {
    await db.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
      [key, JSON.stringify(value)]
    );
    res.json({ key, value });
  } catch (err) {
    console.error('PUT /api/settings error:', err);
    res.status(500).json({ error: 'Failed to save setting', code: 'DB_ERROR' });
  }
});

app.put('/api/settings', async (req, res) => {
  const updates = req.body;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(updates)) {
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, JSON.stringify(value)]
      );
    }
    await client.query('COMMIT');
    res.json({ updated: Object.keys(updates).length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('PUT /api/settings bulk error:', err);
    res.status(500).json({ error: 'Failed to save settings', code: 'DB_ERROR' });
  } finally {
    client.release();
  }
});

// Export routes
app.get('/api/export/json', async (req, res) => {
  try {
    const [entries, people, mentions] = await Promise.all([
      db.query('SELECT * FROM entries ORDER BY date DESC'),
      db.query('SELECT * FROM people ORDER BY name'),
      db.query('SELECT * FROM person_mentions ORDER BY mentioned_at DESC'),
    ]);
    res.json({
      exported_at: new Date().toISOString(),
      entries: entries.rows,
      people: people.rows,
      person_mentions: mentions.rows,
    });
  } catch (err) {
    console.error('Export JSON error:', err);
    res.status(500).json({ error: 'Export failed', code: 'EXPORT_ERROR' });
  }
});

app.get('/api/export/pdf', (req, res) => {
  res.status(501).json({
    error: 'PDF export is coming soon',
    code: 'NOT_IMPLEMENTED',
    message: 'This feature is on the roadmap. Use JSON export for now.',
  });
});

// API routes
app.use('/api/entries', entriesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/insights', insightsRouter);
app.use('/api/people', peopleRouter);

// SPA fallback — serve index.html for any unknown route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🌿 Nook is running at http://localhost:${PORT}`);
});
