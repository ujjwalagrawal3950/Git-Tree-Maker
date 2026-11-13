const { createClient } = require("@supabase/supabase-js");
const { config } = require("./env");

function createAdminClient() {
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey) {
    if (config.nodeEnv === "test" || !config.isProduction) {
      return createClient(
        config.supabaseUrl || "https://placeholder.supabase.co",
        config.supabaseServiceRoleKey || "placeholder-key",
        {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
            detectSessionInUrl: false,
          },
        }
      );
    }
    throw new Error(
      "Supabase admin client is not configured. SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY are required."
    );
  }

  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

/**
 * Service-role client. It bypasses RLS, so callers must have already
 * completed an explicit self, membership, or admin authorization check.
 */
const supabaseAdmin = createAdminClient();

/**
 * User-scoped client for RLS-protected reads. This is optional until Supabase
 * third-party auth for Clerk is configured, so it is not used as a fallback
 * for privileged operations.
 */
function createUserScopedClient(token) {
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error(
      "Supabase user-scoped client is not configured. SUPABASE_URL and " +
        "SUPABASE_ANON_KEY are required."
    );
  }
  if (!token) {
    throw new Error("A Clerk session token is required for a user-scoped client.");
  }

  return createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: {
      headers: { Authorization: `Bearer ${token}` },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

module.exports = { supabaseAdmin, createUserScopedClient };
