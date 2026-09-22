module.exports = () => {
  const crypto = require("node:crypto");
  return crypto.createHash("sha256").update("vaultd").digest("hex").slice(0, 8);
};
