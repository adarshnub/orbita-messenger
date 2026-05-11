import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type MatchContactsBody = {
  phone_hashes: string[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: "Missing Supabase function environment." }, { status: 500, headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return Response.json({ error: "Missing authorization." }, { status: 401, headers: corsHeaders });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const jwt = authHeader.replace("Bearer ", "");
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData.user) {
    return Response.json({ error: "Invalid session." }, { status: 401, headers: corsHeaders });
  }

  const body = (await req.json()) as MatchContactsBody;
  const hashes = [...new Set(body.phone_hashes ?? [])].slice(0, 500);

  if (!hashes.length) {
    return Response.json({ matches: [] }, { headers: corsHeaders });
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id, display_name, phone_hash, avatar_url, about")
    .in("phone_hash", hashes);

  if (error) {
    return Response.json({ error: error.message }, { status: 400, headers: corsHeaders });
  }

  return Response.json(
    {
      matches: data?.filter((profile) => profile.id !== userData.user.id) ?? [],
    },
    { headers: corsHeaders },
  );
});
