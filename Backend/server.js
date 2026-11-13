const { assertRuntimeConfig, config } = require("./config/env");

assertRuntimeConfig();

const app = require("./app");

async function startNgrok() {
  if (!config.ngrokEnabled) return;

  const ngrok = require("@ngrok/ngrok");
  const forwarder = await ngrok.forward({
    addr: `localhost:${config.port}`,
    authtoken_from_env: true,
    domain: config.ngrokDomain || undefined,
  });
  console.log(`ngrok tunnel available at: ${forwarder.url()}`);
}

const server = app.listen(config.port, () => {
  console.log(`Cartograph server running on port ${config.port}`);

  if (config.ngrokEnabled) {
    startNgrok().catch((error) => {
      console.error("ngrok startup failed:", error.message);
    });
  }
});

server.on("error", (error) => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down.`);
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
