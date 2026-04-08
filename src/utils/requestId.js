const crypto = require("crypto");
function requestIdMiddleware() {
  return (req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader("x-request-id", req.requestId);
    next();
  };
}
module.exports = { requestIdMiddleware };