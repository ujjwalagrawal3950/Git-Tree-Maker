const { AppError } = require("./errors");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const CLERK_ID_PATTERN = /^[A-Za-z0-9_]{3,100}$/;

function validationError(message) {
  return new AppError(400, "VALIDATION_ERROR", message);
}

function requirePlainObject(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    throw validationError("A JSON object body is required.");
  }
  return body;
}

function requireString(value, field, options = {}) {
  const min = options.min === undefined ? 1 : options.min;
  const max = options.max === undefined ? 255 : options.max;

  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`);
  }

  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw validationError(
      `${field} must be between ${min} and ${max} characters.`
    );
  }
  if (options.pattern && !options.pattern.test(trimmed)) {
    throw validationError(`${field} has an invalid format.`);
  }
  return trimmed;
}

function optionalString(value, field, options = {}) {
  if (value === undefined || value === null || value === "") return null;
  return requireString(value, field, options);
}

function normalizeEmail(value) {
  const email = requireString(value, "emailAddress", {
    min: 3,
    max: 254,
  }).toLowerCase();

  if (!EMAIL_PATTERN.test(email)) {
    throw validationError("emailAddress must be a valid email address.");
  }
  return email;
}

function normalizeClerkRole(role, fallback = "member") {
  if (role === undefined || role === null || role === "") return fallback;
  if (role === "admin" || role === "org:admin") return "admin";
  if (role === "member" || role === "org:member") return "member";
  return fallback;
}

function validateRole(role) {
  const normalized = normalizeClerkRole(role, null);
  if (!normalized) {
    throw validationError("role must be either admin or member.");
  }
  return normalized;
}

function validateClerkId(value, field) {
  return requireString(value, field, {
    min: 3,
    max: 100,
    pattern: CLERK_ID_PATTERN,
  });
}

function validateSlug(value) {
  return requireString(value, "slug", {
    min: 2,
    max: 64,
    pattern: SLUG_PATTERN,
  });
}

function validateOrganizationName(value) {
  return requireString(value, "name", { min: 1, max: 100 });
}

function validateProfileField(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw validationError(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 100) {
    throw validationError(`${field} must be 100 characters or fewer.`);
  }
  return trimmed || null;
}

function toIsoTimestamp(value, fallback = new Date()) {
  if (value === undefined || value === null || value === "") {
    return fallback.toISOString();
  }

  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === "number") {
    // Clerk timestamps are milliseconds; accept seconds too.
    date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return fallback.toISOString();
  }
  return date.toISOString();
}

const GITHUB_OWNER_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_REPO_PATTERN = /^[a-zA-Z0-9_.-]{1,100}$/;

function validateGithubRepositoryUrl(value) {
  if (typeof value !== "string") {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 255 ||
    trimmed.includes("/../") ||
    trimmed.includes("/./") ||
    trimmed.endsWith("/..") ||
    trimmed.endsWith("/.") ||
    trimmed.includes("\\")
  ) {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  if (parsedUrl.protocol !== "https:") {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  if (parsedUrl.hostname.toLowerCase() !== "github.com") {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  if (parsedUrl.username || parsedUrl.password) {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  if (parsedUrl.search || parsedUrl.hash) {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  const segments = parsedUrl.pathname
    .split("/")
    .filter((segment) => segment.length > 0);

  if (segments.length !== 2) {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  const rawOwner = segments[0];
  let rawRepo = segments[1];

  if (rawRepo.toLowerCase().endsWith(".git")) {
    rawRepo = rawRepo.slice(0, -4);
  }

  if (!GITHUB_OWNER_PATTERN.test(rawOwner)) {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  if (
    !GITHUB_REPO_PATTERN.test(rawRepo) ||
    rawRepo === "." ||
    rawRepo === ".." ||
    rawRepo.includes("..")
  ) {
    throw new AppError(400, "INVALID_GITHUB_URL", "Enter a valid GitHub repository URL.");
  }

  return {
    owner: rawOwner,
    repo: rawRepo,
    canonicalUrl: `https://github.com/${rawOwner}/${rawRepo}`,
  };
}

module.exports = {
  EMAIL_PATTERN,
  SLUG_PATTERN,
  CLERK_ID_PATTERN,
  GITHUB_OWNER_PATTERN,
  GITHUB_REPO_PATTERN,
  validationError,
  requirePlainObject,
  requireString,
  optionalString,
  normalizeEmail,
  normalizeClerkRole,
  validateRole,
  validateClerkId,
  validateSlug,
  validateOrganizationName,
  validateProfileField,
  toIsoTimestamp,
  validateGithubRepositoryUrl,
};
