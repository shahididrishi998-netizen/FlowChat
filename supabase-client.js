// ================================================================
//  supabase-client.js — FlowChat Supabase Configuration
//
//  SETUP: Replace the two values below with your own Supabase
//  project's URL and publishable (anon) key.
//  Get them from: Supabase Dashboard → Project Settings → API
// ================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://lpjnyykzpddvwqelqlzl.supabase.co";        
const SUPABASE_KEY  = "sb_publishable_4mHKeSueSykOBAEzniY2zA_h7IFEEi0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

// Public URL helper for files in the "media" bucket.
export function mediaUrl(path) {
  const { data } = supabase.storage.from("media").getPublicUrl(path);
  return data.publicUrl;
}
