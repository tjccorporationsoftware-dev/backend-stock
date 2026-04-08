const { prisma } = require('../../prismaClient');
const { logActivity } = require('../../utils/auditService');
const logger = require('../../utils/logger');

const createGoodsReceipt = async (req, res, next) => {
    try {
        const { poReference, remarks, attachments, items } = req.body;
        const userId = req.user.id;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "ต้องระบุสินค้าที่ต้องการรับเข้าอย่างน้อย 1 รายการ" });
        }

        if (items.some(item => Number(item.quantity) <= 0)) {
            logActivity(req, `พยายามรับเข้าสินค้าด้วยจำนวนติดลบหรือศูนย์ (อาจเป็นการโจมตี Logic)`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนสินค้าที่รับเข้าต้องมากกว่า 0" });
        }

        const result = await prisma.$transaction(async (tx) => {
            const now = new Date();
            const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
            const prefix = `GR-${yearMonth}-`;

            const lastReceipt = await tx.goodsReceipt.findFirst({
                where: { receiptNo: { startsWith: prefix } },
                orderBy: { receiptNo: 'desc' },
                select: { receiptNo: true }
            });

            let nextNum = 1;
            if (lastReceipt && lastReceipt.receiptNo) {
                const lastPart = lastReceipt.receiptNo.replace(prefix, '');
                nextNum = parseInt(lastPart, 10) + 1;
            }
            const autoReceiptNo = `${prefix}${String(nextNum).padStart(4, '0')}`;

            const receipt = await tx.goodsReceipt.create({
                data: {
                    receiptNo: autoReceiptNo,
                    poReference: poReference || null,
                    remarks: remarks || null,
                    attachments: attachments || [],
                    receivedBy: userId,
                    items: {
                        create: items.map(item => ({
                            productId: item.productId,
                            locationId: item.locationId,
                            quantity: Number(item.quantity),
                            unitCost: Number(item.unitCost) || 0
                        }))
                    }
                },
                include: { items: true }
            });

            const movementData = items.map(item => ({
                type: 'IN',
                productId: item.productId,
                locationId: item.locationId,
                quantity: Number(item.quantity),
                referenceId: receipt.id,
                referenceType: 'GOODS_RECEIPT',
                createdBy: userId
            }));
            await tx.stockMovement.createMany({ data: movementData });

            for (const item of items) {
                await tx.stockBalance.upsert({
                    where: {
                        productId_locationId: { productId: item.productId, locationId: item.locationId }
                    },
                    update: { quantity: { increment: Number(item.quantity) } },
                    create: {
                        productId: item.productId,
                        locationId: item.locationId,
                        quantity: Number(item.quantity)
                    }
                });
            }

            return receipt;
        });
        logActivity(req, `สร้างใบรับสินค้าเข้า: ${result.receiptNo} (${items.length} รายการ)`, "Inbound", result.id, false);

        return res.status(201).json({
            success: true,
            message: "บันทึกรับสินค้าเข้าสต๊อกเรียบร้อยแล้ว",
            data: result
        });
    } catch (error) {
        logger.error("[Inbound] Error creating Goods Receipt", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const listGoodsReceipts = async (req, res, next) => {
    try {
        const rows = await prisma.goodsReceipt.findMany({
            include: {
                _count: { select: { items: true } }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(rows);
    } catch (error) {
        logger.error("[Inbound] Error listing Goods Receipts", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const getGoodsReceiptDetail = async (req, res, next) => {
    try {
        const { id } = req.params;
        const row = await prisma.goodsReceipt.findUnique({
            where: { id },
            include: {
                user: {
                    select: {
                        firstName: true,
                        lastName: true
                    }
                },
                items: {
                    include: {
                        product: true,
                        location: { include: { warehouse: true, zone: true } }
                    }
                }
            }
        });

        if (!row) {
            const safeId = (req.params?.id || id).replace(/[\r\n]/g, '');
            logger.warn(`[Inbound] พยายามเข้าถึงข้อมูลที่ไม่มีอยู่จริง (ID: ${safeId})`, { ip: req.ip, userId: req.user?.id });
            return res.status(404).json({ message: "ไม่พบข้อมูลใบรับสินค้า" });
        }

        res.json(row);
    } catch (error) {
        const safeId = (req.params?.id || id).replace(/[\r\n]/g, '');
        logger.warn(`[Inbound] พยายามเข้าถึงข้อมูลที่ไม่มีอยู่จริง (ID: ${safeId})`, { ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

module.exports = {
    createGoodsReceipt,
    listGoodsReceipts,
    getGoodsReceiptDetail
};