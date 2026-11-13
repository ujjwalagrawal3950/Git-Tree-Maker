const crypto = require("crypto");
const { config } = require("../config/env");
const { AppError } = require("../lib/errors");

function requestId(req, res, next) {
  const id = crypto.randomUUID();
  res.locals.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}

function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=()"
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  res.setHeader("Cache-Control", "no-store");
  if (config.isProduction) {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }
  next();
}

function cors(req, res, next) {
  const origin = req.headers.origin;

  if (origin) {
    if (!config.frontendOrigins.includes(origin)) {
      if (req.method === "OPTIONS") {
        return res.status(403).end();
      }
      return next(
        new AppError(403, "FORBIDDEN", "This origin is not allowed.")
      );
    }

    res.setHeader("Access-Control-Allow-Origin", origin);
    const existingVary = res.getHeader("Vary");
    res.setHeader(
      "Vary",
      existingVary ? `${existingVary}, Origin` : "Origin"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, x-organization-id, svix-id, svix-timestamp, svix-signature"
    );
    res.setHeader("Access-Control-Max-Age", "600");
  }

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  return next();
}

function rateLimit({ windowMs, max, prefix }) {
  const buckets = new Map();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const ip = (req.socket && req.socket.remoteAddress) || req.ip || "unknown";
    const key = `${prefix}:${ip}`;
    let bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfter));
      return next(
        new AppError(
          429,
          "RATE_LIMITED",
          "Too many requests. Try again shortly."
        )
      );
    }

    // Bound memory if the process receives a large number of unique IPs.
    if (buckets.size > 10_000) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }

    return next();
  };
}

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  prefix: "api",
});

const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
  prefix: "webhook",
});

module.exports = {
  requestId,
  securityHeaders,
  cors,
  rateLimit,
  apiLimiter,
  webhookLimiter,
};
