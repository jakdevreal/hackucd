// Checks prompts/scripts.json and uploads it to gs://<bucket>/prompts/scripts.json,
// where GET /api/prompts serves it from. Run: npm run prompts:upload
import { readFileSync } from 'node:fs';
import { Storage } from '@google-cloud/storage';

const SOURCE = new URL('./scripts.json', import.meta.url);
const OBJECT = 'prompts/scripts.json';
const WORDS_PER_MINUTE = 150; // comfortable talking-to-camera pace
const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'];
// Prompts are speaking topics, not scripts read aloud; "script" holds the topic text.
// Same categories the analysis uses, so the frontend can suggest a topic for a weak spot
const FOCUS = ['filler', 'repetition', 'opening', 'clarity', 'structure', 'pacing', 'ending'];

const { prompts } = JSON.parse(readFileSync(SOURCE, 'utf8'));
const problems = [];
const seen = new Set();
if (!Array.isArray(prompts)) problems.push('"prompts" must be an array');

const checked = (prompts || []).map((p, i) => {
  const where = `prompts[${i}] (${p.id ?? 'no id'})`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(p.id ?? '')) problems.push(`${where}: id must be lowercase-with-dashes`);
  if (seen.has(p.id)) problems.push(`${where}: duplicate id`);
  seen.add(p.id);
  for (const field of ['title', 'category', 'script']) {
    if (typeof p[field] !== 'string' || !p[field].trim()) problems.push(`${where}: "${field}" is required`);
  }
  if (!DIFFICULTIES.includes(p.difficulty)) problems.push(`${where}: difficulty must be one of ${DIFFICULTIES.join(', ')}`);
  if (!Array.isArray(p.focus) || !p.focus.length || p.focus.some((f) => !FOCUS.includes(f))) {
    problems.push(`${where}: focus must be a list from ${FOCUS.join(', ')}`);
  }
  if (!Array.isArray(p.tips) || p.tips.some((t) => typeof t !== 'string')) problems.push(`${where}: tips must be a list of strings`);

  const wordCount = String(p.script ?? '').split(/\s+/).filter(Boolean).length;
  return { ...p, wordCount, estimatedSeconds: Math.round((wordCount / WORDS_PER_MINUTE) * 60) };
});

if (problems.length) {
  console.error(`Not uploaded. Fix these in prompts/scripts.json:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const bucket = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT }).bucket(process.env.GCS_BUCKET || 'hackucd-storage');
const body = { updatedAt: new Date().toISOString(), prompts: checked };
await bucket.file(OBJECT).save(JSON.stringify(body, null, 2), {
  contentType: 'application/json',
  resumable: false,
  metadata: { cacheControl: 'no-cache' },
});
console.log(`Uploaded ${checked.length} prompts to gs://${bucket.name}/${OBJECT}`);
