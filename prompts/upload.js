// Checks prompts/scripts.json and uploads it to gs://<bucket>/prompts/scripts.json,
// where GET /api/prompts serves it from. Run: npm run prompts:upload
// Prompts are speaking topics, written as a plain list of strings. Each one gets an id
// made from its first words, which the frontend sends back to POST /analysis as promptId.
import { readFileSync } from 'node:fs';
import { Storage } from '@google-cloud/storage';

const SOURCE = new URL('./scripts.json', import.meta.url);
const OBJECT = 'prompts/scripts.json';
const ID_WORDS = 5;

const { prompts } = JSON.parse(readFileSync(SOURCE, 'utf8'));
const problems = [];
if (!Array.isArray(prompts)) problems.push('"prompts" must be a list of strings');

const seen = new Set();
const checked = (prompts || []).map((text, i) => {
  if (typeof text !== 'string' || !text.trim()) {
    problems.push(`prompts[${i}]: must be a non-empty string`);
    return null;
  }
  // "Pick one concept from your niche..." -> "pick-one-concept-from-your"
  const id = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean).slice(0, ID_WORDS).join('-');
  if (seen.has(id)) problems.push(`prompts[${i}]: starts with the same ${ID_WORDS} words as another prompt; reword one of them`);
  seen.add(id);
  return { id, text: text.trim() };
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
console.log(`Uploaded ${checked.length} prompts to gs://${bucket.name}/${OBJECT}:`);
for (const p of checked) console.log(`  ${p.id}`);
