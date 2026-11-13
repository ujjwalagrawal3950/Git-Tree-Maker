const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeClerkRole,
  validateRole,
  validateClerkId,
  normalizeEmail,
  toIsoTimestamp,
  requirePlainObject,
} = require("../lib/validation");
const { AppError, mapSupabaseError, mapClerkError } = require("../lib/errors");

test("Clerk roles normalize to the two allowed local roles", () => {
  assert.equal(normalizeClerkRole("org:admin"), "admin");
  assert.equal(normalizeClerkRole("org:member"), "member");
  assert.equal(normalizeClerkRole("custom:role"), "member");
  assert.equal(normalizeClerkRole(undefined), "member");
  assert.equal(validateRole("admin"), "admin");
  assert.equal(validateRole("member"), "member");
});

test("unknown roles are rejected on write routes", () => {
  assert.throws(
    () => validateRole("owner"),
    (error) => error instanceof AppError && error.code === "VALIDATION_ERROR"
  );
});

test("Clerk IDs are bounded and character-safe", () => {
  assert.equal(validateClerkId("user_123ABC", "user id"), "user_123ABC");
  assert.equal(validateClerkId("org_123ABC", "org id"), "org_123ABC");
  assert.throws(() => validateClerkId("bad id", "user id"), AppError);
  assert.throws(() => validateClerkId("../admin", "user id"), AppError);
});

test("email normalization is lowercase and validated", () => {
  assert.equal(normalizeEmail("Person@Example.COM"), "person@example.com");
  assert.throws(() => normalizeEmail("not-an-email"), AppError);
});

test("timestamps accept Clerk milliseconds and seconds", () => {
  const millis = 1_700_000_000_000;
  assert.equal(
    toIsoTimestamp(millis),
    new Date(millis).toISOString()
  );
  assert.equal(
    toIsoTimestamp(Math.floor(millis / 1000)),
    new Date(millis).toISOString()
  );
});

test("request bodies must be plain JSON objects", () => {
  assert.deepEqual(requirePlainObject({ name: "Acme" }), { name: "Acme" });
  assert.throws(() => requirePlainObject([]), AppError);
  assert.throws(() => requirePlainObject(null), AppError);
  assert.throws(() => requirePlainObject("text"), AppError);
});

test("database errors map to safe client errors", () => {
  assert.equal(mapSupabaseError({ code: "23505" }).status, 409);
  assert.equal(mapSupabaseError({ code: "23503" }).retryable, true);
  assert.equal(mapSupabaseError({ code: "XX000" }).code, "INTERNAL");
});

test("Clerk errors do not leak provider messages", () => {
  const mapped = mapClerkError({ status: 401, message: "secret detail" });
  assert.equal(mapped.status, 502);
  assert.equal(mapped.code, "CLERK_UNAVAILABLE");
  assert.equal(mapped.message.includes("secret detail"), false);
});
