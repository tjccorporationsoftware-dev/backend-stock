const express = require("express");
const { z } = require("zod");
const multer = require("multer"); // 💡 เพิ่ม multer
const path = require("path");
const fs = require("fs");
const { validate } = require("../../middlewares/validate");
const { login, refresh, logout, me, updateAvatar } = require("./auth.controller"); // 💡 เพิ่ม updateAvatar
const { requireAuth } = require("../../middlewares/authJwt");

const router = express.Router();

// --- 🛠️ ตั้งค่าการเก็บไฟล์ด้วย Multer ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = "public/uploads/avatars";
    // ตรวจสอบว่ามี Folder หรือยัง ถ้าไม่มีให้สร้าง
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // ตั้งชื่อไฟล์ใหม่: avatar-IDผู้ใช้-เวลา.นามสกุลไฟล์
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, `avatar-${req.user.id}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // จำกัดขนาด 2MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("กรุณาอัปโหลดเฉพาะไฟล์รูปภาพ (jpg, png, webp)"), false);
    }
  }
});

const loginSchema = z.object({
  body: z.object({
    username: z.string().trim().min(3, "กรุณากรอก Username").max(100),
    password: z.string().min(1, "กรุณากรอกรหัสผ่าน")
  }).strict(),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

router.post("/login", validate(loginSchema), login);
router.post("/refresh", refresh);
router.post("/logout", requireAuth, logout);
router.get("/me", requireAuth, me);

// 💡 เพิ่ม Route ใหม่สำหรับอัปโหลดรูปโปรไฟล์
// ใช้ชื่อ 'avatar' ให้ตรงกับที่ Frontend ส่งมาใน FormData
router.post("/avatar", requireAuth, upload.single("avatar"), updateAvatar);

module.exports = { authRoutes: router };