const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../middleware/errors");
const { getMe, deleteAccount } = require("../controllers/userController");

const routes = express.Router();

routes.get("/me", requireAuth, asyncHandler(getMe));
routes.delete("/account", requireAuth, asyncHandler(deleteAccount));

module.exports = routes;
