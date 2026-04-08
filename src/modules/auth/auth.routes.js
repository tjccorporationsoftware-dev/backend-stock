const express = require("express");
const { z } = require("zod");
const { validate } = require("../../middlewares/validate");
const { login, refresh, logout, me } = require("./auth.controller");
const { requireAuth } = require("../../middlewares/authJwt");

const router = express.Router();

const loginSchema = z.object({
  body: z.object({
    username: z.string().trim().min(3, "กรุณากรอก Username").max(100),
    password: z.string().trim()
      .min(8, "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร")
      .regex(/[A-Z]/, "รหัสผ่านต้องมีตัวอักษรพิมพ์ใหญ่อย่างน้อย 1 ตัว")
      .regex(/[a-z]/, "รหัสผ่านต้องมีตัวอักษรพิมพ์เล็กอย่างน้อย 1 ตัว")
      .regex(/[0-9]/, "รหัสผ่านต้องมีตัวเลขอย่างน้อย 1 ตัว")
  }).strict(),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

router.post("/login", validate(loginSchema), login);
router.post("/refresh", refresh);
router.post("/logout", requireAuth, logout);
router.get("/me", requireAuth, me);

module.exports = { authRoutes: router };