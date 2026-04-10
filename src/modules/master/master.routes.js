const express = require("express");
const { z } = require("zod");
const { validate } = require("../../middlewares/validate");
const { requireAuth } = require("../../middlewares/authJwt");
const { requirePermissions } = require("../../middlewares/requirePerm");
const c = require("./master.controller");

const router = express.Router();

const codeRegex = /^[a-zA-Z0-9\-_]+$/;
const idRegex = /^[a-zA-Z0-9\-]+$/;
const abbrRegex = /^[A-Z0-9\-]{1,10}$/;

const nameSchema = z.string().trim().min(1).max(150);
const codeSchema = z.string().trim().min(1).max(50).regex(codeRegex, "Code/SKU ต้องเป็นตัวอักษร ตัวเลข ขีดกลาง หรืออันเดอร์สกอร์เท่านั้น");
const idParamSchema = z.object({
    id: z.string().trim().regex(idRegex, "Invalid ID format")
});
const createUnitSchema = z.object({
    body: z.object({ name: nameSchema }).strict(),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});
const updateUnitSchema = z.object({
    body: z.object({ name: nameSchema }).strict(),
    query: z.object({}).passthrough(),
    params: idParamSchema,
});

// 💡 2. Schema สำหรับ Category (มีตัวย่อ)
const createCategorySchema = z.object({
    body: z.object({
        name: nameSchema,
        abbr: z.string().trim().toUpperCase().regex(abbrRegex, "ตัวย่อต้องเป็น A-Z, 0-9 หรือ ขีดกลาง เท่านั้น (สูงสุด 10 ตัวอักษร)").optional().nullable()
    }).strict(),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});
const updateCategorySchema = z.object({
    body: z.object({
        name: nameSchema.optional(),
        abbr: z.string().trim().toUpperCase().regex(abbrRegex, "ตัวย่อไม่ถูกต้อง").optional().nullable()
    }).strict(),
    query: z.object({}).passthrough(),
    params: idParamSchema,
});


const safeOptionalId = z.string().trim().regex(idRegex, "Invalid ID format")
    .or(z.literal(""))
    .nullable()
    .optional()
    .transform(val => val === "" ? null : val);


const createMasterSchema = z.object({
    body: z.object({ name: nameSchema }).strict(),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});

const updateMasterSchema = z.object({
    body: z.object({ name: nameSchema }).strict(),
    query: z.object({}).passthrough(),
    params: idParamSchema,
});

/** Product */
const createProductSchema = z.object({
    body: z.object({
        name: nameSchema,
        categoryId: z.string().trim().min(1, "Category ID ไม่ถูกต้อง"),
        unitId: z.string().trim().min(1, "Unit ID ไม่ถูกต้อง"),
        warehouseId: safeOptionalId,
        zoneId: safeOptionalId,
        locationId: safeOptionalId,
        barcodeValue: z.string().trim().max(100).optional(),
        barcodeType: z.string().trim().max(20).optional(),
    }).strict(),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});
const updateProductSchema = z.object({
    body: z.object({
        name: nameSchema.optional(),
        categoryId: z.string().trim().min(1).optional(),
        unitId: z.string().trim().min(1).optional(),
        warehouseId: safeOptionalId,
        zoneId: safeOptionalId,
        locationId: safeOptionalId,
        barcodeValue: z.string().trim().max(100).nullable().optional(),
        barcodeType: z.string().trim().max(20).nullable().optional(),
        isActive: z.boolean().optional(),
    }).strict(),
    query: z.object({}).passthrough(),
    params: idParamSchema,
});

/** Warehouse, Zone, Location */
const createWarehouseSchema = z.object({
    body: z.object({
        code: codeSchema,
        name: nameSchema,
    }).strict(),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});

const createZoneSchema = z.object({
    body: z.object({
        warehouseId: z.string().trim().min(1),
        code: codeSchema,
        name: nameSchema,
    }).strict(),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});

const createLocationSchema = z.object({
    body: z.object({
        warehouseId: z.string().trim().min(1),
        zoneId: safeOptionalId,
        code: codeSchema,
        name: nameSchema.optional(),
    }).strict(),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});
const updateSupplierSchema = z.object({
    params: z.object({
        id: z.string().uuid("รหัส ID ไม่ถูกต้องตามมาตรฐานความปลอดภัย")
    }),
    body: z.object({
        name: z.string().trim().min(1, "ชื่อคู่ค้าต้องไม่ว่างเปล่า").max(150).optional(),
        taxId: z.string().trim().max(20).optional().nullable(),
        contactName: z.string().trim().max(100).optional().nullable(),
        phone: z.string().trim().max(20).optional().nullable(),
        email: z.string().trim().email("รูปแบบอีเมลไม่ปลอดภัย").optional().nullable().or(z.literal("")),
        address: z.string().trim().max(500).optional().nullable(),
        creditDays: z.coerce.number().int().min(0).optional(),
        avgLeadTime: z.coerce.number().int().min(0).optional(),
    }).passthrough() // 💡 ใช้ passthrough เพื่อไม่ให้พังเวลาหน้าบ้านส่งฟิลด์ส่วนเกินมา แต่เราจะเลือกใช้แค่ข้างบน
});

/** Read Routes */
router.get("/categories", requireAuth, requirePermissions(["MASTER_DATA_READ"]), c.listCategories);
router.get("/units", requireAuth, requirePermissions(["MASTER_DATA_READ"]), c.listUnits);
router.get("/products", requireAuth, requirePermissions(["MASTER_DATA_READ"]), c.listProducts);
router.get("/warehouses", requireAuth, requirePermissions(["MASTER_DATA_READ"]), c.listWarehouses);
router.get("/zones", requireAuth, requirePermissions(["MASTER_DATA_READ"]), c.listZones);
router.get("/locations", requireAuth, requirePermissions(["MASTER_DATA_READ"]), c.listLocations);

/** Manage Routes */
router.post("/categories", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), validate(createCategorySchema), c.createCategory);
router.put("/categories/:id", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), validate(updateCategorySchema), c.updateCategory);
router.delete("/categories/:id", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), c.deleteCategory);

router.post("/units", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), validate(createUnitSchema), c.createUnit);
router.put("/units/:id", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), validate(updateUnitSchema), c.updateUnit);
router.delete("/units/:id", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), c.deleteUnit);

router.post("/products", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), validate(createProductSchema), c.createProduct);
router.patch("/products/:id", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), validate(updateProductSchema), c.updateProduct);
router.delete("/products/:id", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), c.deleteProduct);
router.get("/products/:id/barcode.png", requireAuth, requirePermissions(["MASTER_DATA_READ"]), c.getProductBarcodePng);

router.post("/warehouses", requireAuth, requirePermissions(["WAREHOUSE_MANAGE"]), validate(createWarehouseSchema), c.createWarehouse);
router.post("/zones", requireAuth, requirePermissions(["WAREHOUSE_MANAGE"]), validate(createZoneSchema), c.createZone);
router.post("/locations", requireAuth, requirePermissions(["WAREHOUSE_MANAGE"]), validate(createLocationSchema), c.createLocation);
router.post("/products/batch", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), c.createProductBatch);

router.get("/departments", requireAuth, requirePermissions(["MASTER_DATA_READ"]), c.listDepartments);
router.post("/departments", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), c.createDepartment);
router.put("/departments/:id", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), c.updateDepartment);
router.delete("/departments/:id", requireAuth, requirePermissions(["MASTER_DATA_MANAGE"]), c.deleteDepartment);

// 💡 เพิ่มสิทธิ์ MASTER_DATA_READ ที่ขาดหายไปในส่วนของการดูซัพพลายเออร์
router.get('/suppliers', requireAuth, requirePermissions(['MASTER_DATA_READ']), c.getSuppliers);
router.post('/suppliers', requireAuth, requirePermissions(['MASTER_DATA_MANAGE']), c.createSupplier);
router.get('/suppliers/:id/analytics', requireAuth, requirePermissions(['MASTER_DATA_READ']), c.getSupplierAnalytics);
router.patch('/suppliers/:id', requireAuth, requirePermissions(['MASTER_DATA_MANAGE']), validate(updateSupplierSchema), c.updateSupplier);

router.delete("/warehouses/:id", requireAuth, requirePermissions(['WAREHOUSE_MANAGE']), c.deleteWarehouse);
router.delete("/zones/:id", requireAuth, requirePermissions(['WAREHOUSE_MANAGE']), c.deleteZone);
router.delete("/locations/:id", requireAuth, requirePermissions(['WAREHOUSE_MANAGE']), c.deleteLocation);
module.exports = { masterRoutes: router };