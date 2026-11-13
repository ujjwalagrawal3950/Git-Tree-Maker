const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const nodeEnv = process.env.NODE_ENV || "development";
const isProduction = nodeEnv === "production";

function splitOrigins(value) {
  return String(value || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

const defaultDevelopmentOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const frontendOrigins = splitOrigins(
  process.env.FRONTEND_ORIGIN ||
    (isProduction ? "" : defaultDevelopmentOrigins.join(","))
);

const config = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT || 3000),
  trustProxy:
    String(process.env.TRUST_PROXY || "").toLowerCase() === "true",
  frontendOrigins,
  supabaseUrl: process.env.SUPABASE_URL || "",
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || "",
  clerkSecretKey: process.env.CLERK_SECRET_KEY || "",
  clerkWebhookSecret: process.env.CLERK_WEBHOOK_SECRET || "",
  ngrokEnabled:
    String(process.env.ENABLE_NGROK || "").toLowerCase() === "true",
  ngrokDomain: process.env.NGROK_DOMAIN || "",
  ngrokAuthToken: process.env.NGROK_AUTHTOKEN || "",
  webhookMaxAttempts: Math.max(
    1,
    Number(process.env.WEBHOOK_MAX_ATTEMPTS || 5)
  ),
  webhookStaleMs: Math.max(
    60_000,
    Number(process.env.WEBHOOK_STALE_MS || 300_000)
  ),
  requestBodyLimit: process.env.REQUEST_BODY_LIMIT || "100kb",
  webhookBodyLimit: process.env.WEBHOOK_BODY_LIMIT || "1mb",
};

function assertRuntimeConfig() {
  const missing = [];

  if (!config.supabaseUrl) missing.push("SUPABASE_URL");
  if (!config.supabaseServiceRoleKey) {
    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  }
  if (!config.clerkPublishableKey) missing.push("CLERK_PUBLISHABLE_KEY");
  if (!config.clerkSecretKey) missing.push("CLERK_SECRET_KEY");
  if (!config.clerkWebhookSecret) missing.push("CLERK_WEBHOOK_SECRET");

  if (config.isProduction && config.frontendOrigins.length === 0) {
    missing.push("FRONTEND_ORIGIN");
  }

  if (config.ngrokEnabled && !config.ngrokAuthToken) {
    missing.push("NGROK_AUTHTOKEN");
  }

  if (missing.length > 0) {
    // Variable names only. Never print values.
    console.error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "The server will not start in a partially configured state."
    );
    process.exit(1);
  }
}

module.exports = { config, assertRuntimeConfig };
