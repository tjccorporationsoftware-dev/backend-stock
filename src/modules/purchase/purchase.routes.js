const express = require('express');
const { z } = require('zod');
const router = express.Router();
const { requireAuth } = require('../../middlewares/authJwt');
const { requirePermissions } = require('../../middlewares/requirePerm');
const { validate } = require('../../middlewares/validate');


// อ้างอิงตัว Controller เป็น purchaseController (อย่าเปลี่ยนเป็น c)
const purchaseController = require('./purchase.controller');

const createPrSchema = z.object({
    body: z.object({
        purpose: z.string().trim().min(1, "กรุณาระบุวัตถุประสงค์"),
        departmentId: z.string().uuid().nullable().optional().or(z.literal("")),
        items: z.array(z.object({
            productId: z.string().uuid("รหัสสินค้าไม่ถูกต้อง"),
            quantity: z.coerce.number().int().positive("จำนวนต้องมากกว่า 0"),
            estimatedPrice: z.coerce.number().min(0).optional().default(0)
        })).min(1, "ต้องมีสินค้าอย่างน้อย 1 รายการ")
    }).passthrough()
});

const approvePrSchema = z.object({
    params: z.object({
        id: z.string().uuid("รหัสใบขอซื้อไม่ถูกต้อง")
    }),
    body: z.object({
        status: z.enum(['APPROVED', 'REJECTED']),
        comments: z.string().optional().nullable()
    }).passthrough()
});

router.post('/pr', requireAuth, requirePermissions(['PR_CREATE']), validate(createPrSchema), purchaseController.createPR);
router.get('/pr', requireAuth, requirePermissions(['PR_READ']), purchaseController.listPRs);
router.get('/pr/:id', requireAuth, requirePermissions(['PR_READ']), purchaseController.getPRDetail);
router.post('/pr/:id/approve', requireAuth, requirePermissions(['PR_APPROVE']), validate(approvePrSchema), purchaseController.approvePR);
router.post('/pr/:prId/execute-po', requireAuth, requirePermissions(['AUDIT_LOG_VIEW']), purchaseController.executeApproveAndIssuePO);
router.get('/po/document/:filename', requireAuth, purchaseController.viewPODocument);
router.post('/po/generate', requireAuth, purchaseController.createPOFromPR);
router.post('/pr/:prId/approve-pdf', requireAuth, requirePermissions(['PR_APPROVE']), purchaseController.approvePRWithPDF);

// ดูไฟล์ PDF ใบขอซื้อ (PR)
router.get('/pr/document/:filename', requireAuth, purchaseController.viewPRDocument);


module.exports = { purchaseRoutes: router };