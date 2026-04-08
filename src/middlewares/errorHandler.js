function errorHandler(err, req, res, next) {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ message: "รูปแบบข้อมูล (JSON) ไม่ถูกต้อง" });
  }
  const code = err.statusCode || 500;

  if (code === 500) {
    // 💡 [แก้ไขแล้ว] แยก req.method และ req.url ออกมาเป็น Argument เดี่ยวๆ ด้วยลูกน้ำ (,)
    // เพื่อป้องกันไม่ให้ console.error นำข้อมูลจาก User ไปตีความว่าเป็น Format String (%s, %d)
    console.error("[Unhandled Server Error]", req.method, req.url, ":", err);
  }

  const msg = code === 500 ? "Internal Server Error" : err.message;

  res.status(code).json({ message: msg });
}

module.exports = { errorHandler };