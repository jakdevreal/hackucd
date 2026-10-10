import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080; // Cloud Run injects PORT

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Unknown routes
app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
});

// Catch-all error handler so the frontend always gets JSON back
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: { code: err.code || 'INTERNAL_ERROR', message: err.expose ? err.message : 'Something went wrong' },
  });
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
