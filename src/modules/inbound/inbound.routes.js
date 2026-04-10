const express = require('express');
const { z } = require('zod');
const router = express.Router();

const { requireAuth } = require('../../middlewares/authJwt');
const { requirePermissions } = require('../../middlewares/requirePerm');
const { validate } = require('../../middlewares/validate');

const inboundController = require('./inbound.controller');

const createGoodsReceiptSchema = z.object({
    body: z.object({
        poReference: z.string().trim().nullable().optional(),
        remarks: z.string().trim().nullable().optional(),
        attachments: z.array(z.string().url("รูปแบบ URL ของรูปภาพแนบไม่ถูกต้อง")).optional(),
        items: z.array(
            z.object({
                productId: z.string().trim().min(1, "Product ID ต้องไม่เป็นค่าว่าง"),
                locationId: z.string().trim().min(1, "Location ID ต้องไม่เป็นค่าว่าง"),
                quantity: z.number().int().positive("จำนวนต้องเป็นจำนวนเต็มบวกและมากกว่า 0"),
                unitCost: z.number().min(0, "ต้นทุนต้องไม่ติดลบ").optional().default(0)
            })
        ).min(1, "ต้องมีสินค้าอย่างน้อย 1 รายการ")
    }),
    query: z.object({}).passthrough(),
    params: z.object({}).passthrough(),
});


router.post(
    '/receipts',
    requireAuth,                               // 1. ตรวจสอบ JWT Token
    requirePermissions(['INBOUND_CREATE']),    // 2. ตรวจสอบสิทธิ์
    validate(createGoodsReceiptSchema),        // 3. ตรวจสอบ Payload ด้วย Zod
    inboundController.createGoodsReceipt       // 4. เรียกใช้ Controller
);
router.get('/receipts', requireAuth, requirePermissions(['INBOUND_READ']), inboundController.listGoodsReceipts);
router.get('/receipts/:id', requireAuth, requirePermissions(['INBOUND_READ']), inboundController.getGoodsReceiptDetail);

module.exports = { inboundRoutes: router };