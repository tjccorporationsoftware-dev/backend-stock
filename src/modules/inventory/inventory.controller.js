const { prisma } = require('../../prismaClient');
const { logActivity } = require('../../utils/auditService');
const logger = require('../../utils/logger'); // 💡 [เพิ่ม] นำเข้า Logger
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const getStockBalances = async (req, res, next) => {
    try {
        const { search, productId, warehouseId, locationId, zoneId, categoryId, page = 1, limit = 20 } = req.query;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const take = parseInt(limit);

        const whereCondition = {};

        // --- เริ่มต้น Filter Logic ---
        if (typeof productId === 'string' && productId.trim()) {
            whereCondition.productId = productId;
        }
        if (typeof locationId === 'string' && locationId.trim()) {
            whereCondition.locationId = locationId;
        }
        if (warehouseId || zoneId) {
            whereCondition.location = {};
            if (typeof warehouseId === 'string' && warehouseId.trim()) {
                whereCondition.location.warehouseId = warehouseId;
            }
            if (typeof zoneId === 'string' && zoneId.trim()) {
                whereCondition.location.zoneId = zoneId;
            }
        }
        if (typeof categoryId === 'string' && categoryId.trim()) {
            whereCondition.product = { categoryId };
        }
        if (typeof search === 'string' && search.trim()) {
            whereCondition.OR = [
                { product: { sku: { contains: search.trim(), mode: 'insensitive' } } },
                { product: { name: { contains: search.trim(), mode: 'insensitive' } } },
                { location: { code: { contains: search.trim(), mode: 'insensitive' } } }
            ];
        }
        // --- สิ้นสุด Filter Logic ---

        const [balances, totalCount, allItemsForSum] = await Promise.all([
            // 1. ดึงข้อมูลเฉพาะหน้านั้นๆ (20 รายการ)
            prisma.stockBalance.findMany({
                where: whereCondition,
                take: take,
                skip: skip,
                include: {
                    product: {
                        include: {
                            category: { select: { id: true, name: true, abbr: true } },
                            unit: { select: { id: true, name: true } },
                            warehouse: true, // 💡 ดึงข้อมูลคลัง
                            zone: true       // 💡 ดึงข้อมูลโซน
                        }
                    },
                    location: {
                        include: {
                            warehouse: { select: { id: true, code: true, name: true } },
                            zone: { select: { id: true, code: true, name: true } }
                        }
                    }
                },
                orderBy: { updatedAt: 'desc' } // เอาที่เพิ่งอัปเดตล่าสุดขึ้นก่อน
            }),
            // 2. นับจำนวนรายการทั้งหมดที่ผ่าน Filter
            prisma.stockBalance.count({ where: whereCondition }),
            // 3. ดึงเฉพาะค่าที่ต้องใช้คำนวณมูลค่ารวมทั้งคลัง (ทำเพื่อความเร็ว)
            prisma.stockBalance.findMany({
                where: whereCondition,
                select: {
                    quantity: true,
                    product: { select: { unitCost: true } }
                }
            })
        ]);

        const grandTotalValue = allItemsForSum.reduce((sum, item) => {
            const qty = Number(item.quantity || 0);
            const cost = Number(item.product?.unitCost || 0);
            return sum + (qty * cost);
        }, 0);

        const formattedBalances = balances.map(item => ({
            ...item,
            totalValue: Number(item.quantity) * Number(item.product?.unitCost || 0)
        }));

        return res.status(200).json({
            success: true,
            data: formattedBalances,
            total: totalCount,
            grandTotalValue: grandTotalValue,
            page: parseInt(page),
            limit: take,
            totalPages: Math.ceil(totalCount / take)
        });

    } catch (error) {
        logger.error("[Inventory] Secure Balances Fetch Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const getStockMovements = async (req, res, next) => {
    try {
        const { productId, locationId, type, startDate, endDate } = req.query;

        const whereCondition = {};

        if (productId) whereCondition.productId = productId;
        if (locationId) whereCondition.locationId = locationId;
        if (type) whereCondition.type = type;

        if (startDate || endDate) {
            whereCondition.createdAt = {};
            if (startDate) whereCondition.createdAt.gte = new Date(startDate);
            if (endDate) whereCondition.createdAt.lte = new Date(`${endDate}T23:59:59Z`);
        }

        // 1. ดึงข้อมูล Movement ตามเงื่อนไข (ยังไม่ดึง user เพราะไม่มี Relation โดยตรง)
        const movements = await prisma.stockMovement.findMany({
            where: whereCondition,
            include: {
                product: { select: { sku: true, name: true } },
                location: {
                    select: {
                        code: true,
                        warehouse: { select: { code: true, name: true } }
                    }
                }
            },
            orderBy: {
                createdAt: 'desc'
            }
        });

        // 2. ดึงรายชื่อ User ทั้งหมดที่มีในระบบเพื่อเอามา Mapping
        const users = await prisma.user.findMany({
            select: { id: true, firstName: true, lastName: true }
        });

        // 3. Mapping ชื่อ User เข้ากับแต่ละ Movement โดยเทียบจาก Field `createdBy`
        const formattedMovements = movements.map(movement => {
            const creator = users.find(u => u.id === movement.createdBy);

            return {
                ...movement,
                // สร้าง object user ขึ้นมาจำลองเพื่อให้ Frontend เรียกใช้ m.user.firstName ได้เหมือนเดิม
                user: creator ? { firstName: creator.firstName, lastName: creator.lastName } : null
            };
        });

        return res.status(200).json({
            success: true,
            data: formattedMovements,
            total: formattedMovements.length
        });

    } catch (error) {
        logger.error("[Inventory] Movement Fetch Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const transferStock = async (req, res, next) => {
    try {
        const { transferNo, reason, items } = req.body;
        const userId = req.user.id;

        // 💡 [อัปเกรด Security] ดักจับการโอนย้ายติดลบ หรือโอนเข้าที่เดิมเพื่อป่วน Database
        if (items.some(item => Number(item.quantity) <= 0)) {
            logActivity(req, `พยายามโอนย้ายสต๊อกด้วยจำนวนติดลบหรือศูนย์`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนพัสดุต้องเป็นตัวเลขที่มากกว่า 0" });
        }
        if (items.some(item => item.fromLocationId === item.toLocationId)) {
            logActivity(req, `พยายามโอนย้ายพัสดุเข้าตำแหน่งเดิม (Logic Flaw Attempt)`, "Security", null, true);
            return res.status(400).json({ success: false, message: "ตำแหน่งต้นทางและปลายทางห้ามเป็นจุดเดียวกัน" });
        }

        const transferOrder = await prisma.$transaction(async (tx) => {
            const order = await tx.stockTransfer.create({
                data: {
                    transferNo: transferNo.trim(),
                    reason: reason.trim(),
                    issuedBy: userId,
                    items: {
                        create: items.map(it => ({
                            productId: it.productId,
                            fromLocationId: it.fromLocationId,
                            toLocationId: it.toLocationId,
                            quantity: Number(it.quantity)
                        }))
                    }
                }
            });

            for (const item of items) {
                const fromBalance = await tx.stockBalance.findUnique({
                    where: { productId_locationId: { productId: item.productId, locationId: item.fromLocationId } },
                    include: { location: { include: { warehouse: true } } }
                });

                if (!fromBalance || fromBalance.quantity < item.quantity) {
                    throw new Error(`สินค้าในคลัง ${fromBalance?.location.warehouse.name} ไม่พอสำหรับการโอนย้าย`);
                }

                await tx.stockBalance.update({
                    where: { productId_locationId: { productId: item.productId, locationId: item.fromLocationId } },
                    data: { quantity: { decrement: Number(item.quantity) } }
                });

                await tx.stockBalance.upsert({
                    where: { productId_locationId: { productId: item.productId, locationId: item.toLocationId } },
                    update: { quantity: { increment: Number(item.quantity) } },
                    create: { productId: item.productId, locationId: item.toLocationId, quantity: Number(item.quantity) }
                });

                await tx.stockMovement.createMany({
                    data: [
                        {
                            type: 'TRANSFER', productId: item.productId, locationId: item.fromLocationId,
                            quantity: -Number(item.quantity), createdBy: userId,
                            referenceId: order.id, referenceType: 'INTER_WH_OUT'
                        },
                        {
                            type: 'TRANSFER', productId: item.productId, locationId: item.toLocationId,
                            quantity: Number(item.quantity), createdBy: userId,
                            referenceId: order.id, referenceType: 'INTER_WH_IN'
                        }
                    ]
                });
            }
            return order;
        });

        logActivity(req, `ทำรายการโอนย้ายสต๊อกสินค้า เลขที่: ${transferNo}`, "Inventory", transferOrder.id);
        res.json({ success: true, message: `ใบสั่งย้าย ${transferNo} บันทึกสำเร็จ สต๊อกข้ามคลังถูกปรับปรุงแล้ว` });
    } catch (error) {
        logger.error("[Inventory] Transfer Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: error.message });
    }
};

const listTransferOrders = async (req, res, next) => {
    try {
        const transfers = await prisma.stockTransfer.findMany({
            include: {
                user: { select: { firstName: true, lastName: true } },
                _count: { select: { items: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(transfers);
    } catch (error) {
        logger.error("[Inventory] List Transfer Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const getTransferDetail = async (req, res, next) => {
    try {
        const { id } = req.params;

        const transferOrder = await prisma.stockTransfer.findUnique({
            where: { id },
            include: {
                user: { select: { firstName: true, lastName: true } },
                items: {
                    include: {
                        product: { select: { sku: true, name: true } },
                        fromLocation: { include: { warehouse: true, zone: true } },
                        toLocation: { include: { warehouse: true, zone: true } }
                    }
                }
            }
        });

        if (!transferOrder) {
            // ตัวอย่างการแก้จุดที่เกี่ยวกับ id หรือ error message
            logger.error("[Inventory] GR Creation Error", { error: error.message.replace(/[\r\n]/g, ''), ip: req.ip, userId: req.user?.id });
            return res.status(404).json({ success: false, message: "ไม่พบข้อมูลเอกสารใบโอนย้ายนี้" });
        }
        res.json(transferOrder);
    } catch (error) {
        logger.error("[Inventory] Transfer Detail Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const adjustStock = async (req, res, next) => {
    try {
        const { adjustNo, reasonCode, remarks, items } = req.body;
        const userId = req.user.id;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "กรุณาระบุรายการที่ต้องการปรับปรุง" });
        }

        // 💡 [อัปเกรด Security] ดักจับยอดปรับปรุงเป็นติดลบ (ไม่อนุญาตให้ถือสต๊อกติดลบ)
        if (items.some(item => Number(item.newQuantity) < 0)) {
            logActivity(req, `พยายามปรับยอดสต๊อกให้ติดลบ (Logic Flaw Attempt)`, "Security", null, true);
            return res.status(400).json({ success: false, message: "ไม่อนุญาตให้ปรับยอดสต๊อกติดลบ" });
        }

        const adjustment = await prisma.$transaction(async (tx) => {
            const order = await tx.stockAdjustment.create({
                data: {
                    adjustNo: adjustNo.trim(),
                    reasonCode: reasonCode.trim(),
                    remarks: remarks ? remarks.trim() : null,
                    adjustedBy: userId
                }
            });

            for (const item of items) {
                const targetNewQty = Number(item.newQuantity);

                if (targetNewQty < 0) {
                    throw new Error(`ไม่อนุญาตให้ปรับยอดสต๊อกติดลบ (Product ID: ${item.productId})`);
                }

                const currentBalance = await tx.stockBalance.findUnique({
                    where: { productId_locationId: { productId: item.productId, locationId: item.locationId } }
                });

                const realOldQuantity = currentBalance ? currentBalance.quantity : 0;
                const realDiffQuantity = targetNewQty - realOldQuantity;

                if (realDiffQuantity === 0) continue;

                await tx.stockAdjustment.update({
                    where: { id: order.id },
                    data: {
                        items: {
                            create: {
                                productId: item.productId,
                                locationId: item.locationId,
                                oldQuantity: realOldQuantity,
                                newQuantity: targetNewQty,
                                diffQuantity: realDiffQuantity
                            }
                        }
                    }
                });

                await tx.stockBalance.upsert({
                    where: {
                        productId_locationId: { productId: item.productId, locationId: item.locationId }
                    },
                    update: { quantity: targetNewQty },
                    create: {
                        productId: item.productId,
                        locationId: item.locationId,
                        quantity: targetNewQty
                    }
                });

                await tx.stockMovement.create({
                    data: {
                        type: 'ADJUST',
                        productId: item.productId,
                        locationId: item.locationId,
                        quantity: realDiffQuantity,
                        referenceId: order.id,
                        referenceType: 'STOCK_ADJUSTMENT',
                        createdBy: userId
                    }
                });
            }
            return order;
        });

        logActivity(req, `ทำรายการปรับปรุงยอดสต๊อกสินค้า เลขที่: ${adjustNo}`, "Inventory", adjustment.id);
        res.json({ success: true, message: `บันทึกเอกสารปรับปรุงยอด ${adjustNo} สำเร็จ ข้อมูลถูกส่งเข้า Audit Log แล้ว` });
    } catch (error) {
        logger.error("[Inventory] Stock Adjustment Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: error.message || "เกิดข้อผิดพลาดในการปรับปรุงยอด" });
    }
};

const getAdjustmentHistory = async (req, res, next) => {
    try {
        const rows = await prisma.stockAdjustment.findMany({
            include: {
                user: { select: { firstName: true, lastName: true } }, // 💡 ต้องดึง user มาด้วย
                _count: { select: { items: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(rows);
    } catch (error) { next(error); }
};

const getAdjustmentDetail = async (req, res, next) => {
    try {
        const { id } = req.params;
        const adjustment = await prisma.stockAdjustment.findUnique({
            where: { id },
            include: {
                user: { select: { firstName: true, lastName: true } },
                items: {
                    include: {
                        product: { select: { sku: true, name: true } },
                        location: { select: { code: true, warehouse: { select: { code: true } } } }
                    }
                }
            }
        });

        if (!adjustment) {
            logger.error("[Inventory] GR Creation Error", { error: error.message.replace(/[\r\n]/g, ''), ip: req.ip, userId: req.user?.id });
            return res.status(404).json({ success: false, message: "ไม่พบข้อมูลเอกสารใบปรับปรุงยอดนี้" });
        }
        res.status(200).json(adjustment);
    } catch (error) {
        logger.error("[Inventory] Adjustment Detail Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const createGoodsReceipt = async (req, res, next) => {
    let browser = null;
    try {
        const { receiptNo, purchaseOrderId, remarks, items } = req.body;
        const userId = req.user.id;

        if (items.some(item => Number(item.quantity) <= 0)) {
            logActivity(req, `พยายามรับเข้าสินค้าด้วยจำนวนติดลบหรือศูนย์`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนสินค้าที่รับเข้าต้องมากกว่า 0" });
        }

        const [receiverUser, company] = await Promise.all([
            prisma.user.findUnique({ where: { id: userId }, select: { firstName: true, lastName: true } }),
            prisma.companySettings.findUnique({ where: { id: "main-config" } })
        ]);

        const receiverName = `${receiverUser?.firstName || 'System'} ${receiverUser?.lastName || ''}`.trim();

        const receipt = await prisma.$transaction(async (tx) => {
            if (purchaseOrderId) {
                const po = await tx.purchaseOrder.findUnique({
                    where: { id: purchaseOrderId },
                    include: { items: true }
                });

                if (!po) throw new Error("ไม่พบอ้างอิงใบสั่งซื้อนี้ในระบบ");
                if (po.status === 'COMPLETED') throw new Error("ใบสั่งซื้อนี้รับสินค้าครบถ้วนและถูกปิดไปแล้ว");

                for (const item of items) {
                    const poItem = po.items.find(pi => pi.productId === item.productId);
                    if (!poItem) throw new Error(`สินค้ารหัส ${item.productId} ไม่ได้อยู่ในใบสั่งซื้อนี้`);

                    const totalReceivedWillBe = poItem.receivedQuantity + Number(item.quantity);

                    if (totalReceivedWillBe > poItem.orderedQuantity) {
                        throw new Error(`ไม่อนุญาตให้รับสินค้าเกินจำนวนที่สั่ง! (สั่ง: ${poItem.orderedQuantity}, รับแล้ว: ${poItem.receivedQuantity}, จะรับเพิ่ม: ${item.quantity})`);
                    }

                    await tx.purchaseOrderItem.update({
                        where: { id: poItem.id },
                        data: { receivedQuantity: totalReceivedWillBe }
                    });
                }

                const updatedPoItems = await tx.purchaseOrderItem.findMany({ where: { purchaseOrderId } });
                const isFullyReceived = updatedPoItems.every(pi => pi.receivedQuantity === pi.orderedQuantity);

                await tx.purchaseOrder.update({
                    where: { id: purchaseOrderId },
                    data: { status: isFullyReceived ? 'COMPLETED' : 'PARTIAL' }
                });
            }

            const order = await tx.goodsReceipt.create({
                data: {
                    receiptNo,
                    purchaseOrderId: purchaseOrderId || null,
                    receivedBy: userId,
                    remarks,
                    items: {
                        create: items.map(it => ({
                            productId: it.productId,
                            locationId: it.locationId,
                            quantity: Number(it.quantity),
                            unitCost: Number(it.unitCost) || 0
                        }))
                    }
                }
            });

            for (const item of items) {
                await tx.stockBalance.upsert({
                    where: { productId_locationId: { productId: item.productId, locationId: item.locationId } },
                    update: { quantity: { increment: Number(item.quantity) } },
                    create: { productId: item.productId, locationId: item.locationId, quantity: Number(item.quantity) }
                });

                await tx.product.update({
                    where: { id: item.productId },
                    data: { unitCost: Number(item.unitCost) || 0 }
                });

                await tx.stockMovement.create({
                    data: {
                        type: 'IN',
                        productId: item.productId,
                        locationId: item.locationId,
                        quantity: Number(item.quantity),
                        referenceId: order.id,
                        referenceType: 'GOODS_RECEIPT',
                        createdBy: userId
                    }
                });
            }
            return order;
        });

        const UPLOAD_DIR_GR = path.join(process.cwd(), 'public', 'uploads', 'grs');
        if (!fs.existsSync(UPLOAD_DIR_GR)) fs.mkdirSync(UPLOAD_DIR_GR, { recursive: true });
        const safeReceiptNo = path.basename(receiptNo);
        const fileName = `${safeReceiptNo}.pdf`;
        const filePath = path.join(UPLOAD_DIR_GR, fileName);
        const pdfUrl = `/uploads/grs/${fileName}`;

        // 💡 [อัปเดต] ดึงข้อมูลเพื่อเอาไปวาดลง PDF
        const receiptData = await prisma.goodsReceipt.findUnique({
            where: { id: receipt.id },
            include: {
                purchaseOrder: true,
                items: { include: { product: true, location: { include: { warehouse: true, zone: true } } } }
            }
        });

        const companyName = company?.name || "บริษัท ทีเจซี คอร์ปอเรชั่น จำกัด";
        const companyBranch = company?.branch ? `(${company.branch})` : "";
        const companyAddress = company?.address
            ? `${company.address} ${company.subDistrict} ${company.district} ${company.province} ${company.zipCode}`
            : "ข้อมูลที่อยู่บริษัท";
        const companyTaxId = company?.taxId ? `<p><strong>เลขประจำตัวผู้เสียภาษี:</strong> ${company.taxId}</p>` : "";
        const logoHtml = company?.logoUrl ? `<img src="${company.logoUrl}" style="max-height: 65px; max-width: 140px; object-fit: contain; margin-bottom: 0 !important;" />` : "";

        const totalAmount = receiptData.items.reduce((sum, item) => sum + (item.quantity * item.unitCost), 0);
        const totalQty = receiptData.items.reduce((sum, item) => sum + item.quantity, 0);

        const htmlTemplate = `
            <!DOCTYPE html>
            <html lang="th">
            <head>
                <meta charset="UTF-8">
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap');
                    * { box-sizing: border-box; }
                    body { font-family: 'Sarabun', sans-serif; margin: 0; padding: 0; color: #1e293b; background: white; }
                    .page-container { width: 210mm; height: 297mm; padding: 15mm 20mm; display: flex; flex-direction: column; position: relative; }
                    .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2.5px solid #0f172a; padding-bottom: 15px; margin-bottom: 20px; }
                    .company-profile { display: flex; align-items: center; gap: 15px; }
                    .company-logo img { max-height: 65px; max-width: 140px; object-fit: contain; }
                    .company-info h1 { margin: 0 0 5px 0; font-size: 20px; font-weight: 700; color: #0f172a; }
                    .company-info p { margin: 1px 0; font-size: 12px; color: #1e293b; line-height: 1.4; }
                    .document-title { text-align: right; }
                    .document-title h2 { margin: 0; font-size: 22px; font-weight: 700; color: #475569; }
                    .document-title .doc-no { margin: 8px 0 0 0; font-size: 16px; font-weight: 700; color: #4f46e5; }
                    .info-section { display: flex; justify-content: space-between; margin-bottom: 25px; font-size: 13px; }
                    .info-box { width: 55%; padding: 10px; border-radius: 8px; background-color: #f8fafc; border: 1px solid #e2e8f0; }
                    .info-box-right { width: 40%; text-align: right; padding: 10px; }
                    .label { font-weight: 700; color: #64748b; font-size: 11px; text-transform: uppercase; margin-bottom: 4px; display: block; }
                    .table-wrapper { flex: 1; display: flex; flex-direction: column; margin-bottom: 10px; }
                    table { width: 100%; border-collapse: collapse; height: 100%; }
                    th { background-color: #f1f5f9; border: 1px solid #cbd5e1; padding: 10px 8px; text-align: center; font-size: 12px; font-weight: 700; color: #0f172a; height: 1%; }
                    .item-row td { height: 1%; border-left: 1px solid #cbd5e1; border-right: 1px solid #cbd5e1; border-bottom: 1px dashed #e2e8f0; padding: 10px 8px; font-size: 13px; color: #334155; vertical-align: top; }
                    .empty-row td { height: auto; border-left: 1px solid #cbd5e1; border-right: 1px solid #cbd5e1; border-top: none; border-bottom: none; }
                    .total-row td { height: 1%; border: 1px solid #cbd5e1; padding: 10px 8px; background-color: #f8fafc; font-weight: 700; font-size: 14px; }
                    .remarks-section { margin-top: 5px; font-size: 12px; color: #475569; padding-top: 15px; border-top: 1px dashed #e2e8f0; margin-bottom: 15px; }
                    .footer-signatures { display: flex; justify-content: flex-end; width: 100%; padding-bottom: 10mm; }
                    .sig-block { width: 260px; text-align: center; }
                    .sig-image-wrap { height: 65px; display: flex; align-items: flex-end; justify-content: center; margin-bottom: 8px; }
                    .sig-line { border-top: 1.5px solid #0f172a; margin: 0 auto; width: 220px; padding-top: 6px; }
                    .sig-name { font-size: 13px; font-weight: 700; margin-bottom: 2px; color: #0f172a; }
                    .sig-title { font-size: 11px; color: #64748b; font-weight: 700; }
                    .verified-tag { font-size: 9px; color: #10b981; font-weight: 700; margin-top: 4px; letter-spacing: 1px; }
                </style>
            </head>
            <body>
                <div class="page-container">
                    <div class="header">
                        <div class="company-profile">
                            <div class="company-logo">${logoHtml}</div>
                            <div class="company-info">
                                <h1>${companyName} ${companyBranch}</h1>
                                <p>${companyAddress}</p>
                                ${companyTaxId}
                            </div>
                        </div>
                        <div class="document-title">
                            <h2>ใบรับสินค้าเข้าคลัง (GR)</h2>
                            <div class="doc-no">No. ${receiptNo}</div>
                        </div>
                    </div>

                    <div class="info-section">
                        <div class="info-box">
                            <span class="label">อ้างอิงใบสั่งซื้อ / PO Ref.</span>
                            <div style="font-weight: 700; font-size: 14px; margin-bottom: 8px;">${receiptData.purchaseOrder?.poNumber || 'ไม่มีอ้างอิง (รับเข้าพิเศษ)'}</div>
                            <span class="label">ผู้จำหน่าย / Vendor</span>
                            <div style="font-size: 12px; color: #334155;">${receiptData.purchaseOrder?.vendorName || '-'}</div>
                        </div>
                        <div class="info-box-right">
                            <p><span class="label">วันที่รับของ / Receive Date</span> 
                               ${new Date(receipt.createdAt).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })}
                            </p>
                        </div>
                    </div>

                    <div class="table-wrapper">
                        <table>
                            <thead>
                                <tr>
                                    <th style="width: 50px;">ลำดับ</th>
                                    <th style="text-align: left;">รายการสินค้า / Description</th>
                                    <th style="width: 140px;">สถานที่จัดเก็บ</th>
                                    <th style="width: 70px;">จำนวน</th>
                                    <th style="width: 90px;">ต้นทุน/หน่วย</th>
                                    <th style="width: 110px;">รวมมูลค่า</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${receiptData.items.map((item, index) => {
            const whName = item.location?.warehouse?.name || 'ไม่ระบุคลัง';
            const locName = item.location?.name || item.location?.code || '-';
            const storageText = `${whName} <br/><span style="font-size:10px; color:#64748b;">(จุดวาง: ${locName})</span>`;

            return `
                                    <tr class="item-row">
                                        <td style="text-align: center;">${index + 1}</td>
                                        <td style="font-weight: 700;">
                                            ${item.product?.name} <br/>
                                            <span style="font-size: 10px; font-weight: normal; color: #64748b;">[${item.product?.sku}]</span>
                                        </td>
                                        <td style="text-align: left; font-size: 11px; line-height: 1.3;">${storageText}</td>
                                        <td style="text-align: center; font-weight: 700;">${item.quantity.toLocaleString()}</td>
                                        <td style="text-align: right;">${Number(item.unitCost).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td style="text-align: right; font-weight: 700;">${(item.quantity * item.unitCost).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                    </tr>
                                `}).join('')}
                                <tr class="empty-row"><td></td><td></td><td></td><td></td><td></td><td></td></tr>
                                <tr class="total-row">
                                    <td colspan="3" style="text-align: right; padding-right: 15px;">รวมจำนวน/มูลค่าทั้งสิ้น</td>
                                    <td style="text-align: center;">${totalQty.toLocaleString()}</td>
                                    <td colspan="2" style="text-align: right; color: #4f46e5;">฿${totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <div class="remarks-section">
                        <span class="label">หมายเหตุการรับของ / Remarks:</span>
                        <div style="line-height: 1.6;">${remarks || 'ตรวจสอบสภาพสินค้าเรียบร้อย ครบถ้วนตามจำนวน'}</div>
                    </div>

                    <div class="footer-signatures">
                        <div class="sig-block">
                            <div class="sig-image-wrap">
                                <div style="color: #0f172a; font-weight: 700; font-size: 18px; font-style: italic;">
                                    ${receiverName}
                                </div>
                            </div>
                            <div class="sig-line"></div>
                            <div class="sig-name">( ${receiverName} )</div>
                            <div class="sig-title">เจ้าหน้าที่คลังสินค้า (Receiver)</div>
                            <div class="verified-tag" style="color: #10b981;">✓ DIGITALLY SIGNED</div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `;

        browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(htmlTemplate, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.pdf({ path: filePath, format: 'A4', printBackground: true });
        await browser.close();

        try {
            await prisma.goodsReceipt.update({
                where: { id: receipt.id },
                data: { pdfPath: pdfUrl }
            });
        } catch (e) {
            logger.error("[Inventory] Failed to save PDF Path to DB", { error: e.message });
        }

        logActivity(req, `สร้างใบบันทึกรับสินค้าเข้าคลัง เลขที่: ${receiptNo}`, "Inbound", receipt.id);
        res.json({ success: true, message: "รับสินค้าเข้าคลังและสร้าง PDF สำเร็จ", pdfUrl });

    } catch (error) {
        if (browser) await browser.close();
        logger.error("[Inventory] GR Creation Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: error.message });
    }
};

const getPendingPOs = async (req, res, next) => {
    try {
        const pos = await prisma.purchaseOrder.findMany({
            where: {
                status: { in: ['PENDING', 'PARTIAL'] }
            },
            include: {
                user: { select: { firstName: true, lastName: true } },
                requisition: {
                    include: {
                        user: { select: { firstName: true, lastName: true } },
                        department: { select: { name: true } }
                    }
                },
                _count: { select: { items: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json(pos);
    } catch (error) {
        logger.error("[Inventory] Pending POs Fetch Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const getPODetail = async (req, res, next) => {
    try {
        const { id } = req.params;
        const po = await prisma.purchaseOrder.findUnique({
            where: { id },
            include: {
                requisition: {
                    include: {
                        user: { select: { firstName: true, lastName: true } },
                        approvals: {
                            where: { status: 'APPROVED' },
                            include: {
                                approver: { select: { firstName: true, lastName: true } }
                            },
                            orderBy: { createdAt: 'desc' },
                            take: 1
                        }
                    }
                },
                items: {
                    include: {
                        product: { select: { id: true, sku: true, name: true } }
                    }
                }
            }
        });

        if (!po) {
            logger.error("[Inventory] GR Creation Error", { error: error.message.replace(/[\r\n]/g, ''), ip: req.ip, userId: req.user?.id });
            return res.status(404).json({ success: false, message: "ไม่พบข้อมูลใบสั่งซื้อ" });
        }
        res.status(200).json(po);
    } catch (error) {
        logger.error("[Inventory] PO Detail Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const createPurchaseOrder = async (req, res, next) => {
    try {
        const { poNumber, vendorName, items, prId } = req.body;
        const userId = req.user.id;

        // 💡 [อัปเกรด Security] ดักจำนวน/ราคาติดลบ เพื่อป้องกันการแก้ค่า Amount ให้ติดลบ
        if (items.some(it => Number(it.orderedQuantity) <= 0 || Number(it.unitPrice) < 0)) {
            logActivity(req, `พยายามสร้าง PO ด้วยจำนวนหรือราคาติดลบ/ศูนย์`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนการสั่งซื้อหรือราคาต้องไม่ติดลบหรือเป็นศูนย์" });
        }

        const purchaseOrder = await prisma.$transaction(async (tx) => {
            const existingPO = await tx.purchaseOrder.findUnique({ where: { poNumber } });
            if (existingPO) throw new Error("เลขที่ใบสั่งซื้อนี้มีอยู่ในระบบแล้ว");

            const newPo = await tx.purchaseOrder.create({
                data: {
                    poNumber: poNumber.trim(),
                    vendorName: vendorName.trim(),
                    orderedBy: userId,
                    status: 'PENDING',
                    prId: prId || null,
                    items: {
                        create: items.map(it => ({
                            productId: it.productId,
                            orderedQuantity: Number(it.orderedQuantity),
                            unitPrice: Number(it.unitPrice)
                        }))
                    }
                }
            });
            if (prId) {
                await tx.purchaseRequisition.update({
                    where: { id: prId },
                    data: { status: 'PO_CREATED' }
                });
            }

            return newPo;
        });
        logActivity(req, `สร้างใบสั่งซื้อใหม่ เลขที่: ${poNumber} จาก PR: ${prId || 'Manual'}`, "Purchase", purchaseOrder.id);

        res.status(201).json({
            success: true,
            message: "สร้างใบสั่งซื้อ (PO) สำเร็จ และได้ทำการปิดยอดใบขอซื้อเรียบร้อยแล้ว"
        });
    } catch (error) {
        logger.error("[Inventory] Create PO Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: error.message });
    }
};

const getReceiptHistory = async (req, res, next) => {
    try {
        const receipts = await prisma.goodsReceipt.findMany({
            include: {
                purchaseOrder: { select: { poNumber: true } },
                user: { select: { firstName: true, lastName: true } },
                _count: { select: { items: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json(receipts);
    } catch (error) {
        logger.error("[Inventory] Receipt History Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const getReceiptDetail = async (req, res, next) => {
    try {
        const { id } = req.params;
        const receipt = await prisma.goodsReceipt.findUnique({
            where: { id },
            include: {
                // 1. คนรับของ (GR) เชื่อมผ่าน receivedBy
                user: { select: { firstName: true, lastName: true } },
                items: {
                    include: {
                        product: true,
                        location: { include: { warehouse: true } }
                    }
                },
                purchaseOrder: {
                    include: {
                        // 2. คนเปิด PO เชื่อมผ่าน orderedBy
                        user: { select: { firstName: true, lastName: true } },
                        supplier: true,
                        requisition: {
                            include: {
                                // 3. คนเปิด PR เชื่อมผ่าน requestedBy
                                user: { select: { firstName: true, lastName: true } },
                                // 4. ดึงข้อมูลการอนุมัติ (เอาอันล่าสุดที่อนุมัติแล้ว)
                                approvals: {
                                    where: { status: "APPROVED" },
                                    include: {
                                        approver: { select: { firstName: true, lastName: true } }
                                    },
                                    orderBy: { createdAt: 'desc' },
                                    take: 1
                                }
                            }
                        }
                    }
                }
            }
        });

        if (!receipt) return res.status(404).json({ message: "ไม่พบข้อมูลเอกสาร" });
        res.status(200).json(receipt);
    } catch (error) {
        console.error("Prisma Error:", error.message);
        next(error);
    }
};

const getLowStockAlerts = async (req, res) => {
    try {
        const products = await prisma.product.findMany({
            include: {
                stockBalances: true,
                unit: { select: { name: true } }
            }
        });
        const alerts = products.map(p => {
            const totalQty = (p.stockBalances || []).reduce((sum, b) => sum + b.quantity, 0);
            const threshold = p.minStock > 0 ? p.minStock : 20;

            return {
                id: p.id,
                sku: p.sku,
                name: p.name,
                unit: p.unit?.name,
                threshold: threshold,
                currentStock: totalQty,
                severity: totalQty === 0 ? 'CRITICAL' : totalQty < threshold ? 'WARNING' : 'SAFE'
            };
        }).filter(item => item.currentStock < item.threshold);

        res.json(alerts);
    } catch (error) {
        logger.error("[Inventory] Low Stock Alert Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ success: false, message: error.message });
    }
};

const getAllPOs = async (req, res, next) => {
    try {
        const pos = await prisma.purchaseOrder.findMany({
            include: {
                user: { select: { firstName: true, lastName: true } },
                requisition: {
                    include: {
                        department: { select: { name: true } }
                    }
                },
                _count: { select: { items: true } },
                supplier: true,
                items: true
            },
            orderBy: { createdAt: 'desc' }
        });

        res.status(200).json(pos);
    } catch (error) {
        logger.error("[Inventory] Get All POs Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const generatePOPdf = async (req, res, next) => {
    let browser = null;
    try {
        const { id } = req.params;

        const po = await prisma.purchaseOrder.findUnique({
            where: { id },
            include: {
                user: { select: { firstName: true, lastName: true } },
                items: { include: { product: { select: { sku: true, name: true } } } },
                requisition: {
                    include: {
                        department: { select: { name: true } },
                        user: { select: { firstName: true, lastName: true } }
                    }
                }
            }
        });

        if (!po) return res.status(404).json({ message: "ไม่พบข้อมูลใบสั่งซื้อ" });

        if (po.pdfPath && fs.existsSync(po.pdfPath)) {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="PO-${po.poNumber}.pdf"`);
            return res.sendFile(path.resolve(po.pdfPath));
        }

        const subTotal = po.items.reduce((sum, item) => sum + (Number(item.orderedQuantity) * Number(item.unitPrice)), 0);
        const vatAmount = subTotal * 0.07;
        const netTotal = subTotal + vatAmount;
        const poDate = new Date(po.createdAt).toLocaleDateString('th-TH', {
            year: 'numeric', month: 'long', day: 'numeric'
        });

        const htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;600;700;800&display=swap');
                body { font-family: 'Sarabun', sans-serif; margin: 0; padding: 0; color: #1e293b; background-color: #fff; }
                .page { padding: 40px; position: relative; }
                .header-table { width: 100%; border-bottom: 4px solid #0f172a; padding-bottom: 20px; margin-bottom: 30px; }
                .company-info h1 { margin: 0; font-size: 32px; font-weight: 800; color: #0f172a; letter-spacing: -1px; }
                .company-info p { margin: 2px 0; font-size: 11px; color: #64748b; }
                .doc-title { text-align: right; }
                .doc-title h2 { margin: 0; font-size: 24px; font-weight: 800; color: #4f46e5; text-transform: uppercase; }
                .info-section { display: table; width: 100%; margin-bottom: 40px; }
                .info-box { display: table-cell; width: 50%; vertical-align: top; }
                .info-card { background: #f8fafc; border-radius: 12px; padding: 15px; border: 1px solid #e2e8f0; width: 90%; }
                table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
                thead th { background-color: #0f172a; color: #fff; padding: 12px; font-size: 11px; text-transform: uppercase; }
                tbody td { padding: 12px; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
                .total-row { display: table; width: 350px; float: right; padding: 15px; background: #4f46e5; color: #fff; border-radius: 8px; font-weight: 800; }
                .signature-section { margin-top: 80px; display: table; width: 100%; }
                .sig-box { display: table-cell; width: 33%; text-align: center; }
                .sig-space { height: 60px; border-bottom: 2px dashed #94a3b8; width: 180px; margin: 0 auto 10px auto; }
                .stamp-area { border: 2px dashed #e2e8f0; width: 80px; height: 80px; border-radius: 50%; display: inline-block; line-height: 80px; color: #e2e8f0; font-size: 10px; font-weight: 800; }
            </style>
        </head>
        <body>
            <div class="page">
                <table class="header-table">
                    <tr>
                        <td class="company-info" style="border:none;">
                            <h1>บริษัท ทีเจซี คอร์ปอเรชั่น จำกัด</h1>
                            <p>ม.4 ตำบลคำน้ำเเซบ อำเภอวารินชำราบ อุบลราชธานี 34190</p>
                            <p>เลขประจำตัวผู้เสียภาษี: 0325563000203 | โทรศัพท์: 099-361-3247</p>
                        </td>
                        <td class="doc-title" style="border:none; vertical-align: top;">
                            <h2>ใบสั่งซื้อสินค้า (PO)</h2>
                            <p>เลขที่เอกสาร: ${po.poNumber}</p>
                        </td>
                    </tr>
                </table>

                <div class="info-section">
                    <div class="info-box">
                        <div class="info-card">
                            <div style="font-size:10px; font-weight:800; color:#94a3b8; margin-bottom:5px;">สั่งซื้อจาก (SUPPLIER)</div>
                            <div style="font-weight:800; font-size:14px;">${po.vendorName}</div>
                            <div style="font-size:12px; color:#64748b; margin-top:2px;">เรียน: แผนกขาย / ผู้รับผิดชอบ</div>
                        </div>
                    </div>
                    <div class="info-box" style="padding-left: 40px; font-size:13px; line-height: 1.6;">
                        <div><strong>วันที่สั่งซื้อ:</strong> ${poDate}</div>
                        <div><strong>แผนกที่ร้องขอ:</strong> ${po.requisition?.department?.name || "ส่วนกลาง (Operations)"}</div>
                        <div><strong>อ้างอิงใบขอซื้อ (PR):</strong> ${po.requisition?.prNumber || "-"}</div>
                    </div>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th width="10%">ลำดับ</th>
                            <th align="left" width="45%">รายการสินค้า (Description)</th>
                            <th width="10%">จำนวน</th>
                            <th align="right" width="15%">ราคา/หน่วย</th>
                            <th align="right" width="20%">จำนวนเงินรวม</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${po.items.map((item, index) => `
                            <tr>
                                <td align="center">${index + 1}</td>
                                <td>
                                    <div style="font-weight:700;">${item.product?.name}</div>
                                    <div style="font-size:11px; color:#4f46e5;">รหัสสินค้า: ${item.product?.sku}</div>
                                </td>
                                <td align="center">${item.orderedQuantity}</td>
                                <td align="right">${Number(item.unitPrice).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                                <td align="right" style="font-weight:700;">${(item.orderedQuantity * item.unitPrice).toLocaleString('th-TH', { minimumFractionDigits: 2 })}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>

                <div class="total-row">
                    <div style="display:table-cell;">ยอดชำระสุทธิ (NET TOTAL)</div>
                    <div style="display:table-cell; text-align:right; font-size:18px;">฿${netTotal.toLocaleString('th-TH', { minimumFractionDigits: 2 })}</div>
                </div>

                <div class="signature-section">
                    <div class="sig-box">
                        <div class="sig-space"></div>
                        <div style="font-size:12px; font-weight:700;">${po.user?.firstName || "พนักงานจัดซื้อ"}</div>
                        <div style="font-size:10px; color:#94a3b8;">ผู้จัดทำ (Prepared By)</div>
                    </div>
                    <div class="sig-box">
                        <div class="stamp-area">ประทับตรา</div>
                    </div>
                    <div class="sig-box">
                        <div class="sig-space"></div>
                        <div style="font-size:12px; font-weight:700;">ผู้มีอำนาจลงนาม</div>
                        <div style="font-size:10px; color:#94a3b8;">ผู้อนุมัติสั่งซื้อ (Authorized By)</div>
                    </div>
                </div>
            </div>
        </body>
        </html>
        `;

        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'domcontentloaded' });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
        });

        const storageDir = path.join(__dirname, '../../storage/pos');
        if (!fs.existsSync(storageDir)) {
            fs.mkdirSync(storageDir, { recursive: true });
        }

        const safePoNumber = path.basename(po.poNumber);
        const fileName = `PO-${safePoNumber}-${Date.now()}.pdf`;
        const fullPath = path.join(storageDir, fileName);
        fs.writeFileSync(fullPath, pdfBuffer);

        await prisma.purchaseOrder.update({
            where: { id },
            data: { pdfPath: fullPath }
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="PO-${po.poNumber}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        logger.error("[Inventory] Premium PDF Generation Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ success: false, message: "สร้างเอกสารล้มเหลว" });
    } finally {
        if (browser) await browser.close();
    }
};

const viewGRDocument = (req, res) => {
    try {
        const { filename } = req.params;

        // 💡 [อัปเกรด Security] ดักจับการจู่โจมแบบ Path Traversal
        if (filename.includes('..') || filename.includes('/')) {
            logActivity(req, `พยายามเจาะระบบอ่านไฟล์นอกระบบ (Path Traversal): ${filename}`, "Security", null, true);
            logger.error("[Inventory] GR Creation Error", { error: error.message.replace(/[\r\n]/g, ''), ip: req.ip, userId: req.user?.id });
            return res.status(403).send("Forbidden");
        }

        const filePath = path.join(process.cwd(), 'public', 'uploads', 'grs', filename);

        if (fs.existsSync(filePath)) {
            res.contentType("application/pdf");
            return res.sendFile(filePath);
        } else {
            return res.status(404).json({ message: "ไม่พบไฟล์เอกสารบนเซิร์ฟเวอร์" });
        }
    } catch (error) {
        logger.error("[Inventory] View GR Document Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: "ระบบประมวลผลไฟล์ล้มเหลว" });
    }
};
const getDashboardMovementSummary = async (req, res, next) => {
    try {
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 6);
        startDate.setHours(0, 0, 0, 0);

        const movements = await prisma.stockMovement.findMany({
            where: { createdAt: { gte: startDate, lte: endDate } },
            select: { type: true, quantity: true, createdAt: true }
        });

        const summary = {};
        for (let i = 6; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().split('T')[0];
            const displayDate = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
            summary[dateStr] = { date: displayDate, IN: 0, OUT: 0 };
        }

        movements.forEach(m => {
            const mDate = new Date(m.createdAt);
            mDate.setHours(mDate.getHours() + 7);
            const dateStr = mDate.toISOString().split('T')[0];

            if (summary[dateStr]) {
                const qty = Number(m.quantity);
                const type = m.type; // 💡 จับจาก Type โดยตรง ชัวร์ที่สุด!

                if (type === 'IN') {
                    summary[dateStr].IN += Math.abs(qty);
                } else if (type === 'OUT') {
                    summary[dateStr].OUT += Math.abs(qty);
                } else {
                    // สำหรับ TRANSFER หรือ ADJUST ให้เช็คจากยอดบวก/ลบ
                    if (qty > 0) summary[dateStr].IN += Math.abs(qty);
                    if (qty < 0) summary[dateStr].OUT += Math.abs(qty);
                }
            }
        });

        res.status(200).json({ success: true, data: Object.values(summary) });
    } catch (error) {
        next(error);
    }
};
const getAgedStock = async (req, res, next) => {
    try {
        // รับค่าจำนวนวัน (ค่าเริ่มต้นคือ 90 วัน) และฟิลเตอร์อื่นๆ
        const { days = 90, warehouseId, categoryId } = req.query;

        // คำนวณหาวันที่ย้อนหลัง
        const thresholdDate = new Date();
        thresholdDate.setDate(thresholdDate.getDate() - parseInt(days));

        const whereCondition = {
            quantity: { gt: 0 }, // ต้องมีของอยู่จริง
            updatedAt: { lte: thresholdDate } // ไม่มีการอัปเดตหรือเคลื่อนไหวเลยตั้งแต่วันที่คำนวณได้
        };

        if (warehouseId) whereCondition.location = { warehouseId };
        if (categoryId) whereCondition.product = { categoryId };

        const agedStocks = await prisma.stockBalance.findMany({
            where: whereCondition,
            include: {
                product: {
                    select: {
                        sku: true,
                        name: true,
                        unitCost: true,
                        category: { select: { name: true } }
                    }
                },
                location: {
                    select: {
                        code: true,
                        warehouse: { select: { name: true } }
                    }
                }
            },
            orderBy: { updatedAt: 'asc' } // เอาที่ค้างนานที่สุด (เก่าสุด) ขึ้นก่อน
        });

        // คำนวณมูลค่าเงินจม (Dead Stock Value)
        const totalValue = agedStocks.reduce((sum, item) => {
            return sum + (item.quantity * (item.product?.unitCost || 0));
        }, 0);

        res.status(200).json({
            success: true,
            data: agedStocks,
            totalItems: agedStocks.length,
            totalValue: totalValue,
            daysThreshold: parseInt(days),
            thresholdDate: thresholdDate.toISOString().split('T')[0]
        });

    } catch (error) {
        logger.error("[Inventory] Aged Stock Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

module.exports = {
    getStockBalances,
    getStockMovements,
    transferStock,
    listTransferOrders,
    getTransferDetail,
    adjustStock,
    getAdjustmentHistory,
    getAdjustmentDetail,
    createGoodsReceipt,
    getPendingPOs,
    getPODetail,
    createPurchaseOrder,
    getReceiptHistory,
    getReceiptDetail,
    getAllPOs,
    getLowStockAlerts,
    generatePOPdf,
    viewGRDocument,
    getDashboardMovementSummary,
    getAgedStock
};