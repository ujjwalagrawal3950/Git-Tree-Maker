const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errors");
const {
  verifyRepository,
  generateManifest,
  retrieveFiles,
  parseRepository,
} = require("../controllers/repositoryController");

const routes = express.Router();

routes.post("/repositories/verify", requireAuth, asyncHandler(verifyRepository));
routes.post("/repositories/manifest", requireAuth, asyncHandler(generateManifest));
routes.post("/repositories/files", requireAuth, asyncHandler(retrieveFiles));
routes.post("/repositories/parse", requireAuth, asyncHandler(parseRepository));

module.exports = routes;
