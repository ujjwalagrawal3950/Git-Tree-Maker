const express = require("express");
const { clerkMiddleware } = require("@clerk/express");
const { config } = require("./config/env");
const {
  requestId,
  securityHeaders,
  cors,
  apiLimiter,
  webhookLimiter,
} = require("./middleware/security");
const { asyncHandler, notFoundHandler, errorHandler } = require("./middleware/errors");
const { handleClerkWebhook } = require("./controllers/webhookController");
const userRoutes = require("./routes/userRoutes");
const organizationRoutes = require("./routes/organizationRoutes");
const repositoryRoutes = require("./routes/repositoryRoutes");
const graphRoutes = require("./routes/graphRoutes");
const ingestionRoutes = require("./routes/ingestionRoutes");

const app = express();

app.disable("x-powered-by");

// Only trust a forwarded IP when the deployment explicitly says it sits
// behind exactly one trusted proxy. Otherwise a client could spoof X-Forwarded-For
// and bypass the in-process rate limiter.
if (config.trustProxy) app.set("trust proxy", 1);

app.use(requestId);
app.use(securityHeaders);

// The webhook must be mounted before the JSON parser so Svix sees the raw
// bytes. It is also deliberately outside the CORS allowlist: Clerk is a
// server-to-server caller and the signature is the authentication boundary.
app.post(
  "/api/webhooks/clerk",
  webhookLimiter,
  express.raw({ type: "application/json", limit: config.webhookBodyLimit }),
  asyncHandler(handleClerkWebhook)
);

app.use(cors);
app.use(express.json({ limit: config.requestBodyLimit, strict: true }));

app.use("/api", apiLimiter);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    data: { status: "ok" },
  });
});

app.use(
  clerkMiddleware({
    authorizedParties: config.frontendOrigins,
  })
);

app.use("/api", userRoutes);
app.use("/api", organizationRoutes);
app.use("/api", repositoryRoutes);
app.use("/api", graphRoutes);
app.use("/api", ingestionRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
