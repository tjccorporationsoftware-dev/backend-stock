const express = require("express");
const { z } = require("zod");
const { validate } = require("../../middlewares/validate");
const { requireAuth } = require("../../middlewares/authJwt");
const { requirePermissions } = require("../../middlewares/requirePerm");
const c = require("./users.controller");

const router = express.Router();

const usernameRegex = /^[a-zA-Z0-9_]{3,30}$/;
const nameSchema = z.string().trim().min(1, "ห้ามเป็นค่าว่าง");
const passwordSchema = z.string().trim().min(8, "รหัสผ่านอย่างน้อย 8 ตัวอักษร");
const optionalDept = z.string().trim().nullable().optional().or(z.literal(''));


const updateSchema = z.object({
  // 💡 เพิ่มส่วนนี้เข้าไปเพื่อให้ Middleware ไม่ตัด id ทิ้ง
  params: z.object({
    id: z.string().min(1, "ต้องระบุ ID")
  }),
  body: z.object({
    firstName: nameSchema.optional(),
    lastName: nameSchema.optional(),
    password: passwordSchema.optional(),
    isActive: z.boolean().optional(),
    departmentId: optionalDept
  }).strict()
});

// --- ส่วนของ Schema Create (แนะนำให้เพิ่มด้วยเพื่อความเสถียร) ---
const createSchema = z.object({
  body: z.object({
    username: z.string().trim().regex(usernameRegex, "Username ภาษาอังกฤษ/ตัวเลขเท่านั้น"),
    firstName: nameSchema,
    lastName: nameSchema,
    password: passwordSchema,
    departmentId: optionalDept
  }).strict()
});

const ADMIN_KEY = 'AUDIT_LOG_VIEW';

// --- User Management ---
router.get("/", requireAuth, requirePermissions([ADMIN_KEY]), c.listUsers);
router.get("/:id", requireAuth, requirePermissions([ADMIN_KEY]), c.getUser);
router.post("/", requireAuth, requirePermissions([ADMIN_KEY]), validate(createSchema), c.createUser);
router.patch("/:id", requireAuth, requirePermissions([ADMIN_KEY]), validate(updateSchema), c.updateUser);
router.delete("/:id", requireAuth, requirePermissions([ADMIN_KEY]), c.deleteUser);
router.post("/:id/roles", requireAuth, requirePermissions([ADMIN_KEY]), c.setRoles);

// --- Security Matrix ---
router.get("/roles/list", requireAuth, requirePermissions([ADMIN_KEY]), c.listRoles);
router.get("/roles/:roleId/permissions", requireAuth, requirePermissions([ADMIN_KEY]), c.getRolePermissions);
router.post("/roles/:roleId/permissions", requireAuth, requirePermissions([ADMIN_KEY]), c.updateRolePermissions);

module.exports = { userRoutes: router };