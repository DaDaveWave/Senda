import { createClient } from '@supabase/supabase-js';

// Service role key — full DB access, server-side only
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
