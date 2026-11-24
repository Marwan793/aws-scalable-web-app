const fs = require('fs');
const path = require('path');
const express = require('express');
const { Pool } = require('pg');

// Database settings come from environment variables:
// PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (read by "pg" automatically).
// PGSSLROOTCERT points to the RDS CA bundle so the connection is encrypted and verified.
const pool = new Pool({
  ssl: process.env.PGSSLROOTCERT
    ? { ca: fs.readFileSync(process.env.PGSSLROOTCERT, 'utf8') }
    : false,
});

const app = express();
app.use(express.json());

// Health check for the ALB target group.
// It does not query the database, so an RDS failover does not mark every instance unhealthy.
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Static files (CSS, JS). CloudFront caches everything under /static/*.
app.use(
  '/static',
  express.static(path.join(__dirname, 'public', 'static'), { maxAge: '1d' }),
);

// HTML page. Not cached, so a new release is visible right away.
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// List the latest notes.
app.get('/api/notes', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, body, created_at FROM notes ORDER BY id DESC LIMIT 50',
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Could not load notes' });
  }
});

// Add a note.
app.post('/api/notes', async (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (body.length === 0 || body.length > 500) {
    return res.status(400).json({ error: 'Note must be 1-500 characters' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO notes (body) VALUES ($1) RETURNING id, body, created_at',
      [body],
    );
    return res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({ error: 'Could not save note' });
  }
});

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`notes-app listening on port ${port}`);
});

// Graceful shutdown: finish in-flight requests when the instance is being terminated.
process.on('SIGTERM', () => {
  server.close(() => pool.end().then(() => process.exit(0)));
});
