// Tiny helper invoked from the workflow's post-step when the `run.mjs`
// step fails. Just flips the attempt row to 'errored' so we don't leave
// the dedup slot occupied.

import { createClient } from '@supabase/supabase-js';

const [, , attemptId, reason] = process.argv;
if (!attemptId) process.exit(0);

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) { console.log('Supabase env missing; skipping'); process.exit(0); }

const s = createClient(url, key, { auth: { persistSession: false } });
const { error } = await s.from('autofix_attempts')
  .update({
    status: 'errored',
    error_message: String(reason || 'unknown').slice(0, 500),
    updated_at: new Date().toISOString(),
  })
  .eq('id', attemptId);
if (error) { console.error('mark-errored failed', error.message); process.exit(0); }
console.log('attempt marked errored');
