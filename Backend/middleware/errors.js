const { AppError, safeMessage } = require("../lib/errors");

function asyncHandler(handler) {
  return function wrappedHandler(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function notFoundHandler(req, res) {
  return res.status(404).json({
    success: false,
    error: {
      code: "NOT_FOUND",
      message: "Route not found.",
      requestId: res.locals.requestId || null,
    },
  });
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }

  const requestId = res.locals.requestId || null;
  let status = 500;
  let code = "INTERNAL";
  let message = safeMessage("INTERNAL");

  if (err instanceof AppError) {
    status = err.status;
    code = err.code;
    message = err.message || safeMessage(code);
  } else if (err && err.type === "entity.parse.failed") {
    status = 400;
    code = "VALIDATION_ERROR";
    message = "The request body is not valid JSON.";
  } else if (err && err.type === "entity.too.large") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "The request body is too large.";
  } else if (err && err.code === "LIMIT_FILE_SIZE") {
    status = 413;
    code = "PAYLOAD_TOO_LARGE";
    message = "The request body is too large.";
  }

  if (status >= 500) {
    // Detailed errors stay server-side. Do not log request bodies or tokens.
    console.error(`[${requestId || "no-request-id"}]`, err);
  }

  return res.status(status).json({
    success: false,
    error: {
      code,
      message,
      requestId,
    },
  });
}

module.exports = { asyncHandler, notFoundHandler, errorHandler };
