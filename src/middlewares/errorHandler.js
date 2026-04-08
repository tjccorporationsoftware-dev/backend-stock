function errorHandler(err, req, res, next) {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: "รูปแบบข้อมูล (JSON) ไม่ถูกต้อง" });
  }
  const code = err.statusCode || 500;

  if (code === 500) {
    console.error("[Unhandled Server Error]", req.method, req.url, ":", err);
  }

  const msg = code === 500 ? "Internal Server Error" : err.message;

  res.status(code).json({ message: msg });
}

module.exports = { errorHandler };