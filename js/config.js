import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'

const SUPABASE_URL = 'https://wjqtgyoncwswwkonnpye.supabase.co'
const SUPABASE_KEY = 'sb_publishable_f-5d_NuNGArYNevBYH-cEA_Tfplp746'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
