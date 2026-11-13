const test = require("node:test");
const assert = require("node:assert/strict");

// Configure a known webhook secret BEFORE config/env is loaded so the
// handler verifies against this test secret instead of a live one.
const TEST_WEBHOOK_SECRET =
  "whsec_" +
  Buffer.from("cartograph-local-test-secret-0123456789").toString("base64");
const WRONG_WEBHOOK_SECRET =
  "whsec_" +
  Buffer.from("some-other-secret-material-9876543210").toString("base64");

if (!process.env.CLERK_PUBLISHABLE_KEY) {
  process.env.CLERK_PUBLISHABLE_KEY =
    "pk_test_d2hvbGUtc2hyZXctNDY5OS5jbGVyay5hY2NvdW50cy5kZXYk";
}
if (!process.env.CLERK_SECRET_KEY) {
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder_key_for_testing_purposes";
}
process.env.CLERK_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;

const { Webhook } = require("svix");

// Replace the ledger claim BEFORE webhookController is required: the
// controller destructures its imports at load time, so it captures this
// stub. If a rejected delivery ever reaches the database, the counter
// increases and the assertion fails. This is the automated form of
// Phase 02 acceptance criterion 21 ("no database changes").
const webhookEvents = require("../services/webhookEvents");
let ledgerCalls = 0;
webhookEvents.claimWebhookEvent = async () => {
  ledgerCalls += 1;
  throw new Error("webhook ledger must not be touched by a rejected delivery");
};

const { handleClerkWebhook } = require("../controllers/webhookController");

function createResSpy() {
  const state = { status: null, body: null };
  return {
    state,
    res: {
      status(code) {
        state.status = code;
        return this;
      },
      json(body) {
        state.body = body;
        return this;
      },
    },
  };
}

function signedHeaders(payload, { secret = TEST_WEBHOOK_SECRET } = {}) {
  const msgId = `msg_test_${Math.random().toString(36).slice(2)}`;
  const timestamp = new Date();
  const signature = new Webhook(secret).sign(msgId, timestamp, payload);
  return {
    "svix-id": msgId,
    "svix-timestamp": Math.floor(timestamp.getTime() / 1000).toString(),
    "svix-signature": signature,
  };
}

const SAMPLE_EVENT = JSON.stringify({
  type: "user.created",
  created_at: "2026-11-13T00:00:00.000Z",
  data: { id: "user_test_1" },
});

test("webhook: missing Svix headers are rejected with 400 and no ledger write", async () => {
  const { state, res } = createResSpy();
  const req = { headers: {}, body: SAMPLE_EVENT };

  await handleClerkWebhook(req, res);

  assert.equal(state.status, 400);
  assert.equal(state.body.success, false);
  assert.equal(state.body.error.code, "VALIDATION_ERROR");
  assert.equal(state.body.error.message, "Missing Svix headers.");
  assert.equal(ledgerCalls, 0);
});

test("webhook: invalid signature is rejected with 400 and no ledger write", async () => {
  const { state, res } = createResSpy();
  const req = {
    headers: signedHeaders(SAMPLE_EVENT, { secret: WRONG_WEBHOOK_SECRET }),
    body: SAMPLE_EVENT,
  };

  await handleClerkWebhook(req, res);

  assert.equal(state.status, 400);
  assert.equal(state.body.success, false);
  assert.equal(state.body.error.code, "VALIDATION_ERROR");
  assert.equal(state.body.error.message, "Invalid webhook signature.");
  assert.equal(ledgerCalls, 0);
});

test("webhook: payload tampering invalidates a previously valid signature", async () => {
  const { state, res } = createResSpy();
  const original = JSON.stringify({
    type: "user.created",
    created_at: "2026-11-13T00:00:00.000Z",
    data: { id: "user_test_1" },
  });
  const tampered = JSON.stringify({
    type: "user.created",
    created_at: "2026-11-13T00:00:00.000Z",
    data: { id: "user_attacker_2" },
  });
  const req = {
    headers: signedHeaders(original),
    body: tampered,
  };

  await handleClerkWebhook(req, res);

  assert.equal(state.status, 400);
  assert.equal(state.body.error.code, "VALIDATION_ERROR");
  assert.equal(state.body.error.message, "Invalid webhook signature.");
  assert.equal(ledgerCalls, 0);
});

test("webhook: rejected deliveries never wrote to the ledger (all cases)", () => {
  assert.equal(ledgerCalls, 0);
});
