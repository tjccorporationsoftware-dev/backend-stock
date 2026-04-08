const express = require('express');
const { z } = require('zod');
const router = express.Router();

const { requireAuth } = require('../../middlewares/authJwt');
const { requirePermissions } = require('../../middlewares/requirePerm');
const { validate } = require('../../middlewares/validate');
const transferController = require('./transfer.controller');

// ==========================================
// 🛡️ ZOD SCHEMAS (แก้ไขให้ยืดหยุ่นขึ้น)
// ==========================================

// 1. Schema สำหรับตอนกด "ส่งของ" (Ship)
const shipSchema = z.object({
    body: z.object({
        referenceNo: z.string().optional().nullable(),
        remarks: z.string().optional().nullable(),
        items: z.array(
            z.object({
                // 💡 เปลี่ยนจาก .uuid() เป็น .min(1) เพื่อป้องกัน Error 400 กรณี ID มีรูปแบบพิเศษ
                productId: z.string().min(1, "กรุณาระบุรหัสสินค้า"),
                fromLocationId: z.string().min(1, "กรุณาระบุตำแหน่งต้นทาง"),
                toLocationId: z.string().min(1, "กรุณาระบุตำแหน่งปลายทาง"),
                quantity: z.number().int().positive("จำนวนต้องเป็นตัวเลขบวกที่มากกว่า 0")
            }).refine((data) => data.fromLocationId !== data.toLocationId, {
                message: "ตำแหน่งต้นทางและปลายทางต้องไม่เป็นที่เดียวกัน",
                path: ["toLocationId"]
            })
        ).min(1, "ต้องมีสินค้าอย่างน้อย 1 รายการ")
    }),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});

// 2. Schema สำหรับตอน "รับของ" (Receive)
const receiveSchema = z.object({
    params: z.object({
        // 💡 รับ ID ของใบโอนย้ายจาก URL
        id: z.string().min(1, "ID ของใบโอนย้ายไม่ถูกต้อง")
    }),
    body: z.object({
        items: z.array(
            z.object({
                // 💡 itemId คือ ID ของแถวใน StockTransferItem
                itemId: z.string().min(1, "Item ID ต้องไม่เป็นค่าว่าง"),
                receivedQty: z.number().int().min(0, "จำนวนที่รับต้องไม่ติดลบ")
            })
        ).min(1, "ต้องมีรายการรับอย่างน้อย 1 รายการ")
    }).passthrough(),
    query: z.object({}).passthrough()
});

router.get('/', requireAuth, requirePermissions(['INVENTORY_READ']), transferController.listPendingTransfers);

router.get('/history', requireAuth, requirePermissions(['INVENTORY_READ']), transferController.getTransferHistory);
router.get('/:id', requireAuth, requirePermissions(['INVENTORY_READ']), transferController.getTransferById);
router.post('/ship', requireAuth, requirePermissions(['TRANSFER_CREATE']), validate(shipSchema), transferController.shipTransfer);
router.put('/:id/receive', requireAuth, requirePermissions(['TRANSFER_CREATE']), validate(receiveSchema), transferController.receiveTransfer);

module.exports = { transferRoutes: router };