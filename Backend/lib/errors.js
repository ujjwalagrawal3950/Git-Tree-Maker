class AppError extends Error {
  constructor(status, code, message, options = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.retryAfterSeconds = Number(options.retryAfterSeconds) || null;
    this.cause = options.cause;
  }
}

const ERROR_MESSAGES = {
  UNAUTHENTICATED: "Sign in is required.",
  NO_ACTIVE_ORGANIZATION:
    "Select an active organization before using this route.",
  ORG_CONTEXT_MISMATCH:
    "The active organization does not match the requested organization.",
  FORBIDDEN: "You do not have permission to perform this action.",
  NOT_FOUND: "The requested resource was not found.",
  VALIDATION_ERROR: "The request contains invalid or missing fields.",
  CONFLICT: "The action conflicts with the current state.",
  LAST_ADMIN: "The organization must keep at least one active admin.",
  CLERK_UNAVAILABLE: "The identity service is unavailable.",
  INVALID_GITHUB_URL: "Enter a valid GitHub repository URL.",
  REPOSITORY_NOT_FOUND: "Repository not found or inaccessible.",
  PRIVATE_REPOSITORY: "Private repositories are not supported.",
  REPOSITORY_MOVED: "Repository has moved. Use its current GitHub URL.",
  GITHUB_RATE_LIMITED: "GitHub API rate limit reached. Try again later.",
  GITHUB_TIMEOUT: "GitHub did not respond in time. Try again.",
  GITHUB_UNAVAILABLE: "GitHub is temporarily unavailable. Try again shortly.",
  GITHUB_INVALID_RESPONSE: "GitHub returned an unexpected response.",
  REPOSITORY_EMPTY: "The repository has no commits or is empty.",
  GIT_TREE_NOT_FOUND: "The Git tree for this repository could not be found.",
  COMMIT_NOT_FOUND: "The specified commit or reference could not be found.",
  INTERNAL: "An unexpected server error occurred.",
};

function safeMessage(code, fallback) {
  return ERROR_MESSAGES[code] || fallback || ERROR_MESSAGES.INTERNAL;
}

function mapSupabaseError(error, context = "database") {
  const code = error && error.code;

  if (code === "23505") {
    return new AppError(409, "CONFLICT", safeMessage("CONFLICT"));
  }
  if (code === "23503") {
    return new AppError(409, "CONFLICT", safeMessage("CONFLICT"), {
      retryable: true,
    });
  }
  if (code === "P0002" || code === "PGRST116") {
    return new AppError(404, "NOT_FOUND", safeMessage("NOT_FOUND"));
  }

  return new AppError(500, "INTERNAL", safeMessage("INTERNAL"), {
    retryable: true,
    cause: error,
  });
}

function mapClerkError(error) {
  const status = Number(error && (error.status || error.statusCode));
  const clerkCode =
    (error &&
      error.errors &&
      error.errors[0] &&
      error.errors[0].code) ||
    (error && error.code) ||
    "";
  const normalizedCode = String(clerkCode).toLowerCase();

  if (status === 404) {
    return new AppError(404, "NOT_FOUND", safeMessage("NOT_FOUND"));
  }
  if (
    status === 409 ||
    normalizedCode.includes("already") ||
    normalizedCode.includes("exists") ||
    normalizedCode.includes("duplicate")
  ) {
    return new AppError(409, "CONFLICT", safeMessage("CONFLICT"));
  }
  if (status === 400 || status === 422) {
    return new AppError(400, "VALIDATION_ERROR", safeMessage("VALIDATION_ERROR"));
  }
  if (status === 401 || status === 403) {
    return new AppError(502, "CLERK_UNAVAILABLE", safeMessage("CLERK_UNAVAILABLE"));
  }

  return new AppError(502, "CLERK_UNAVAILABLE", safeMessage("CLERK_UNAVAILABLE"), {
    retryable: true,
    cause: error,
  });
}

function isAppError(error) {
  return error instanceof AppError;
}

module.exports = {
  AppError,
  ERROR_MESSAGES,
  safeMessage,
  mapSupabaseError,
  mapClerkError,
  isAppError,
};
