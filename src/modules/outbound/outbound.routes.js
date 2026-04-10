const express = require('express');
const { z } = require('zod');
const router = express.Router();

const { requireAuth } = require('../../middlewares/authJwt');
const { requirePermissions } = require('../../middlewares/requirePerm');
const { validate } = require('../../middlewares/validate');
const outboundController = require('./outbound.controller');


// ==========================================
// 🛡️ ZOD SCHEMAS
// ==========================================

const createDeliveryOrderSchema = z.object({
    body: z.object({
        doNo: z.string().trim().min(1, "กรุณาระบุเลขที่ใบจ่ายสินค้า (DO No)"),
        reference: z.string().trim().nullable().optional(),
        remarks: z.string().trim().nullable().optional(),
        srId: z.string().uuid().optional().nullable(), // 💡 เพิ่มสำหรับผูกใบเบิก
        items: z.array(
            z.object({
                productId: z.string().trim().min(1, "Product ID ห้ามว่าง"),
                locationId: z.string().trim().min(1, "Location ID ห้ามว่าง"),
                quantity: z.number({
                    required_error: "กรุณาระบุจำนวน",
                    invalid_type_error: "จำนวนต้องเป็นตัวเลขเท่านั้น"
                }).int().positive("จำนวนต้องมากกว่า 0")
            })
        ).min(1, "ต้องมีรายการสินค้าอย่างน้อย 1 รายการ")
    }).passthrough()
});

const createRequisitionSchema = z.object({
    body: z.object({
        srNumber: z.string().trim().min(3, "เลขที่ SR สั้นเกินไป"),
        purpose: z.string().trim().min(1, "กรุณาระบุวัตถุประสงค์การเบิก"),
        departmentId: z.string().uuid().optional().nullable(),
        priority: z.enum(['NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
        requiredDate: z.string().optional().nullable(),
        referenceNo: z.string().trim().optional().nullable(),
        deliveryLocation: z.string().trim().optional().nullable(),
        remarks: z.string().trim().optional().nullable(),
        items: z.array(z.object({
            productId: z.string().uuid("รหัสสินค้าไม่ถูกต้อง"),
            quantity: z.coerce.number().int().min(1, "จำนวนเบิกต้องมากกว่า 0"),
            remark: z.string().trim().optional().nullable()
        })).min(1, "ต้องมีสินค้าอย่างน้อย 1 รายการ")
    }).passthrough()
});

const updateRequisitionStatusSchema = z.object({
    params: z.object({
        id: z.string().uuid("ID ใบเบิกไม่ถูกต้อง")
    }),
    body: z.object({
        status: z.enum(['APPROVED', 'REJECTED'], {
            errorMap: () => ({ message: "สถานะต้องเป็น APPROVED หรือ REJECTED เท่านั้น" })
        })
    }).passthrough()
});

// ==========================================
// 🚀 ROUTES (OUTBOUND & REQUISITION)
// ==========================================


// --- Delivery Order Section ---
router.post(
    '/delivery-orders',
    requireAuth,
    requirePermissions(['OUTBOUND_CREATE']),
    validate(createDeliveryOrderSchema),
    outboundController.createDeliveryOrder
);

router.get(
    '/delivery-orders', 
    requireAuth, 
    requirePermissions(['OUTBOUND_READ']), 
    outboundController.listDeliveryOrders
);

// 💡 เพิ่ม validate ตรวจสอบ UUID ป้องกัน Server พังจากการรับค่าผิดรูปแบบ
router.get(
    '/delivery-orders/:id', 
    requireAuth, 
    requirePermissions(['OUTBOUND_READ']), 
    validate(z.object({ params: z.object({ id: z.string().uuid("รูปแบบ ID ไม่ถูกต้อง") }) })),
    outboundController.getDeliveryOrderDetail
);

// --- Stock Requisition Section ---
// 💡 เปลี่ยนจาก inventoryController เป็น outboundController ตามไฟล์ที่เราเพิ่งย้ายไป
router.post(
    '/requisitions',
    requireAuth,
    requirePermissions(['REQUISITION_CREATE']),
    validate(createRequisitionSchema),
    outboundController.createStockRequisition
);

// 💡 เพิ่มการดักสิทธิ์ ป้องกันคนไม่มีสิทธิ์แอบดึงข้อมูลยอดเบิกของแต่ละแผนก
router.get(
    '/requisitions/department-consumption',
    requireAuth,
    requirePermissions(['REQUISITION_READ']), 
    outboundController.getDepartmentConsumption
);

router.get(
    '/requisitions/pending',
    requireAuth,
    requirePermissions(['REQUISITION_APPROVE']),
    outboundController.getPendingRequisitions
);

router.put(
    '/requisitions/:id/status',
    requireAuth,
    requirePermissions(['REQUISITION_APPROVE']),
    validate(updateRequisitionStatusSchema),
    outboundController.updateRequisitionStatus
);

// 💡 เพิ่มสิทธิ์ REQUISITION_READ ที่ของเดิมยังไม่ได้ใส่ไว้
router.get(
    '/requisitions',
    requireAuth,
    requirePermissions(['REQUISITION_READ']),
    outboundController.listRequisitions
);

module.exports = { outboundRoutes: router };