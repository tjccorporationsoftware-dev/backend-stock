
function validate(schema) {
  return (req, res, next) => {
    try {
      if (!schema) return next();

      const parsed = schema.parse({
        body: req.body,
        query: req.query,
        params: req.params
      });

      req.body = parsed.body;
      req.query = parsed.query;
      req.params = parsed.params;
      next();
    } catch (e) {
      if (e.errors && Array.isArray(e.errors)) {
        const formattedErrors = e.errors.map(err => ({
          field: err.path.join('.'),
          message: err.message
        }));
        return res.status(400).json({ message: "ข้อมูลไม่ถูกต้อง", errors: formattedErrors });
      }
      return res.status(400).json({
        message: "Validation error",
        errors: e.message || "รูปแบบข้อมูลไม่ถูกต้อง"
      });
    }
  };
}

module.exports = { validate };