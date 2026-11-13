const { AppError } = require("../lib/errors");
const { getOrSyncUser, deleteUserAndCascade, toUserResponse } = require("../services/user");
const { deleteClerkUser } = require("../services/clerk");

async function getMe(req, res) {
  const user = await getOrSyncUser(req.actor.userId);
  if (!user) {
    throw new AppError(404, "NOT_FOUND", "User profile not found.");
  }

  return res.status(200).json({
    success: true,
    data: toUserResponse(user),
  });
}

async function deleteAccount(req, res) {
  // Clerk is the source of truth. Delete there first so a failure cannot leave
  // an active Clerk identity pointing at a removed local row. The webhook is a
  // second convergence path if the local delete below fails.
  await deleteClerkUser(req.actor.userId);
  await deleteUserAndCascade(req.actor.userId, new Date().toISOString());

  console.log(`Account deleted for user ${req.actor.userId}`);
  return res.status(204).send();
}

module.exports = { getMe, deleteAccount };
