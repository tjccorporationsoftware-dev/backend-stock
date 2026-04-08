const express = require('express');
const { z } = require('zod');
const router = express.Router();

const { requireAuth } = require('../../middlewares/authJwt');
const { requirePermissions } = require('../../middlewares/requirePerm');
const { validate } = require('../../middlewares/validate');
const inventoryController = require('./inventory.controller');

// ==========================================
// 🛡️ ZOD SCHEMAS (รัดกุมสูงทุกมิติ)
// ==========================================

const getInventorySchema = z.object({
    query: z.object({
        search: z.string().trim().max(100).optional(),
        categoryId: z.string().trim().max(50).optional(),
        productId: z.string().trim().max(50).optional(),
        warehouseId: z.string().trim().max(50).optional(),
        locationId: z.string().trim().max(50).optional(),
        zoneId: z.string().trim().max(50).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(500).default(50),
    }).passthrough(),
});

const getMovementSchema = z.object({
    query: z.object({
        productId: z.string().uuid().optional(),
        locationId: z.string().uuid().optional(),
        type: z.enum(['IN', 'OUT', 'ADJUST', 'TRANSFER']).optional(),
        startDate: z.string().refine((val) => !isNaN(Date.parse(val)), "วันที่เริ่มต้นไม่ถูกต้อง").optional(),
        endDate: z.string().refine((val) => !isNaN(Date.parse(val)), "วันที่สิ้นสุดไม่ถูกต้อง").optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    }).passthrough(),
});

const transferSchema = z.object({
    body: z.object({
        transferNo: z.string().trim().min(5).max(50),
        reason: z.string().trim().max(255).optional(),
        items: z.array(z.object({
            productId: z.string().uuid(),
            fromLocationId: z.string().uuid(),
            toLocationId: z.string().uuid(),
            quantity: z.number().int().positive()
        })).min(1)
    }).passthrough()
});

const adjustmentSchema = z.object({
    body: z.object({
        adjustNo: z.string().trim().min(1),
        reasonCode: z.string().min(1),
        remarks: z.string().optional().nullable().or(z.literal('')),
        items: z.array(z.object({
            productId: z.string().min(1),
            locationId: z.string().min(1),
            oldQuantity: z.coerce.number().min(0),
            newQuantity: z.coerce.number().min(0),
            diffQuantity: z.coerce.number()
        })).min(1)
    }).passthrough()
});

const goodsReceiptSchema = z.object({
    body: z.object({
        receiptNo: z.string().min(1, "กรุณาระบุเลขที่ใบรับสินค้า"),
        purchaseOrderId: z.string().trim().min(1, "กรุณาเลือกใบสั่งซื้อ"),
        remarks: z.string().optional().nullable(),
        items: z.array(z.object({
            productId: z.string().trim().min(1, "รหัสสินค้าไม่ถูกต้อง"),
            locationId: z.string().trim().min(1, "ตำแหน่งเก็บไม่ถูกต้อง"),
            quantity: z.coerce.number().int().positive("จำนวนต้องมากกว่า 0"),
            unitCost: z.coerce.number().min(0).optional()
        })).min(1, "ต้องมีสินค้าอย่างน้อย 1 รายการ")
    }).passthrough()
});

const createPOSchema = z.object({
    body: z.object({
        poNumber: z.string().trim().min(3, "เลขที่ PO สั้นเกินไป"),
        vendorName: z.string().trim().min(1, "กรุณาระบุชื่อ Supplier/ผู้ขาย"),
        items: z.array(z.object({
            productId: z.string().uuid("รหัสสินค้าไม่ถูกต้อง"),
            orderedQuantity: z.coerce.number().min(1, "จำนวนสั่งซื้อต้องมากกว่า 0"),
            unitPrice: z.coerce.number().min(0, "ราคาต้องไม่ติดลบ")
        })).min(1, "ต้องมีสินค้าอย่างน้อย 1 รายการ")
    }).passthrough()
});

const agedStockSchema = z.object({
    query: z.object({
        days: z.coerce.number().int().min(1).default(90), // ค่าตั้งต้นคือไม่ขยับเลย 90 วัน
        warehouseId: z.string().trim().max(50).optional(),
        categoryId: z.string().trim().max(50).optional(),
    }).passthrough(),
});

// ==========================================
// ROUTES (กำหนดสิทธิ์แบบ Least Privilege)
// ==========================================

router.get('/balances', requireAuth, requirePermissions(['INVENTORY_VIEW']), validate(getInventorySchema), inventoryController.getStockBalances);
router.get('/movements', requireAuth, requirePermissions(['INVENTORY_VIEW']), validate(getMovementSchema), inventoryController.getStockMovements);

router.post('/transfer', requireAuth, requirePermissions(['INVENTORY_TRANSFER']), validate(transferSchema), inventoryController.transferStock);
router.get('/transfer', requireAuth, requirePermissions(['INVENTORY_VIEW']), inventoryController.listTransferOrders);
router.get('/transfer/:id', requireAuth, requirePermissions(['INVENTORY_VIEW']), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), inventoryController.getTransferDetail);

router.post('/adjust', requireAuth, requirePermissions(['INVENTORY_ADJUST']), validate(adjustmentSchema), inventoryController.adjustStock);
router.get('/adjust', requireAuth, requirePermissions(['INVENTORY_VIEW']), inventoryController.getAdjustmentHistory);
router.get('/adjust/:id', requireAuth, requirePermissions(['INVENTORY_VIEW']), inventoryController.getAdjustmentDetail);

router.post(
    '/receipt',
    requireAuth,
    requirePermissions(['INBOUND_CREATE']),
    validate(goodsReceiptSchema),
    inventoryController.createGoodsReceipt
);

router.get(
    '/receipt',
    requireAuth,
    requirePermissions(['INVENTORY_VIEW']),
    inventoryController.getReceiptHistory
);
router.get('/receipt/document/:filename', requireAuth, inventoryController.viewGRDocument);

router.get('/receipt/:id', requireAuth, requirePermissions(['INVENTORY_VIEW']), validate(z.object({ params: z.object({ id: z.string().uuid() }) })), inventoryController.getReceiptDetail);

router.get(
    '/pos/pending',
    requireAuth,
    requirePermissions(['INBOUND_CREATE']),
    inventoryController.getPendingPOs
);

router.get(
    '/pos/:id',
    requireAuth,
    requirePermissions(['INBOUND_CREATE']),
    validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
    inventoryController.getPODetail
);

router.get(
    '/pos/:id/pdf',
    requireAuth,
    inventoryController.generatePOPdf
);

router.post(
    '/pos',
    requireAuth,
    requirePermissions(['PURCHASE_CREATE']),
    validate(createPOSchema),
    inventoryController.createPurchaseOrder
);

router.get(
    '/low-stock-alerts',
    requireAuth,
    requirePermissions(['INVENTORY_READ']),
    inventoryController.getLowStockAlerts
);

router.get(
    '/pos',
    requireAuth,
    requirePermissions(['PURCHASE_CREATE']),
    inventoryController.getAllPOs
);
router.get(
    '/dashboard/movements-summary',
    requireAuth,
    requirePermissions(['INVENTORY_VIEW']),
    inventoryController.getDashboardMovementSummary
);

// 2. นำ Route ไปวางไว้ในกลุ่ม ROUTES (แนะนำให้วางก่อน route ที่เป็น /:id)
router.get(
    '/aged-stock',
    requireAuth,
    requirePermissions(['INVENTORY_VIEW']),
    validate(agedStockSchema),
    inventoryController.getAgedStock
);

module.exports = { inventoryRoutes: router };