const jwt = require("jsonwebtoken");
const crypto = require("crypto");

function signAccessToken(userId, perms) {
  return jwt.sign(
    {
      id: userId,
      perms: perms
    },
    process.env.JWT_ACCESS_SECRET,
    {
      expiresIn: "15m",
      issuer: "newstock-product",
      subject: userId,
    }
  );
}

function newRefreshTokenPlain() {
  return crypto.randomBytes(64).toString("hex");
}

function hashRefreshToken(plain) {
  return crypto.createHash("sha256").update(plain).digest("hex");
}

module.exports = { signAccessToken, newRefreshTokenPlain, hashRefreshToken };