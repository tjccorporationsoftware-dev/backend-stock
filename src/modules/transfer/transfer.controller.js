const { prisma } = require('../../prismaClient');
const { logActivity } = require('../../utils/auditService');
const logger = require('../../utils/logger');

// ==========================================
// 1. ดึงรายการที่กำลังจัดส่ง (สำหรับแท็บ "รับของเข้า")
// ==========================================
const listPendingTransfers = async (req, res, next) => {
    try {
        const transfers = await prisma.stockTransfer.findMany({
            where: { status: 'SHIPPED' },
            include: {
                issuedUser: { select: { firstName: true, lastName: true } },
                items: {
                    include: {
                        product: true,
                        toLocation: { include: { warehouse: true, zone: true } },
                        fromLocation: { include: { warehouse: true, zone: true } }
                    }
                }
            },
            orderBy: { shippedAt: 'asc' }
        });
        res.json({ success: true, data: transfers });
    } catch (error) {
        logger.error("[Transfer] List Pending Error", { error: error.message });
        res.status(500).json({ success: false, message: "ดึงข้อมูลรายการรอรับไม่สำเร็จ" });
    }
};

// ==========================================
// 2. ขั้นตอนส่งของออก (Ship Transfer)
// ==========================================
const shipTransfer = async (req, res, next) => {
    try {
        // 💡 แก้ให้ชื่อตัวแปรตรงกับ Frontend และ Zod Schema
        const { referenceNo, remarks, items } = req.body;
        const userId = req.user.id;

        const result = await prisma.$transaction(async (tx) => {
            // 💡 ถ้าไม่ได้กรอกเลขเอกสาร ให้ระบบสร้างให้แบบ Auto
            let finalTransferNo = referenceNo;
            if (!finalTransferNo) {
                const now = new Date();
                const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
                const count = await tx.stockTransfer.count({
                    where: { transferNo: { startsWith: `TO-${dateStr}` } }
                });
                finalTransferNo = `TO-${dateStr}-${String(count + 1).padStart(3, '0')}`;
            }

            const transfer = await tx.stockTransfer.create({
                data: {
                    transferNo: finalTransferNo,
                    reason: remarks,
                    issuedBy: userId,
                    status: 'SHIPPED',
                    shippedAt: new Date(),
                    items: {
                        create: items.map(it => ({
                            productId: it.productId,
                            fromLocationId: it.fromLocationId,
                            toLocationId: it.toLocationId,
                            shippedQty: Number(it.quantity)
                        }))
                    }
                }
            });

            // ตัดสต๊อกจากคลังต้นทางทันที
            for (const item of items) {
                const balance = await tx.stockBalance.findUnique({
                    where: { productId_locationId: { productId: item.productId, locationId: item.fromLocationId } }
                });

                if (!balance || balance.quantity < item.quantity) {
                    throw new Error(`สินค้าในคลังต้นทางไม่พอสำหรับการส่งออก (SKU: ${item.productId})`);
                }

                await tx.stockBalance.update({
                    where: { productId_locationId: { productId: item.productId, locationId: item.fromLocationId } },
                    data: { quantity: { decrement: Number(item.quantity) } }
                });

                await tx.stockMovement.create({
                    data: {
                        type: 'TRANSFER',
                        productId: item.productId,
                        locationId: item.fromLocationId,
                        quantity: -Number(item.quantity),
                        referenceId: transfer.id,
                        referenceType: 'TRANSFER_SHIPPED',
                        createdBy: userId
                    }
                });
            }
            return transfer;
        });

        logActivity(req, `ส่งออกสินค้าโอนย้าย: ${result.transferNo}`, "Inventory", result.id, false);
        res.json({ success: true, message: "บันทึกการส่งออกสำเร็จ สินค้าอยู่ระหว่างขนส่ง" });
    } catch (error) {
        logger.error("[Transfer] Ship Error", { error: error.message });
        res.status(400).json({ success: false, message: error.message || "เกิดข้อผิดพลาดในการส่งออก" });
    }
};

// ==========================================
// 3. ขั้นตอนรับของเข้าปลายทาง (Receive Transfer)
// ==========================================
const receiveTransfer = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { items } = req.body;
        const userId = req.user.id;

        await prisma.$transaction(async (tx) => {
            const transfer = await tx.stockTransfer.findUnique({
                where: { id },
                include: { items: true }
            });

            if (!transfer) throw new Error("ไม่พบข้อมูลใบโอนย้าย");
            if (transfer.status !== 'SHIPPED') throw new Error("สถานะใบงานไม่ถูกต้อง (ต้องเป็นสถานะระหว่างขนส่ง)");

            await tx.stockTransfer.update({
                where: { id },
                data: {
                    status: 'COMPLETED',
                    receivedBy: userId,
                    receivedAt: new Date()
                }
            });

            for (const itemInput of items) {
                const originalItem = transfer.items.find(it => it.id === itemInput.itemId);
                if (!originalItem) continue;

                const rQty = Number(itemInput.receivedQty);

                // อัปเดตจำนวนที่รับได้จริง
                await tx.stockTransferItem.update({
                    where: { id: itemInput.itemId },
                    data: { receivedQty: rQty }
                });

                // เพิ่มสต๊อกเข้าคลังปลายทาง
                await tx.stockBalance.upsert({
                    where: { productId_locationId: { productId: originalItem.productId, locationId: originalItem.toLocationId } },
                    update: { quantity: { increment: rQty } },
                    create: { productId: originalItem.productId, locationId: originalItem.toLocationId, quantity: rQty }
                });

                await tx.stockMovement.create({
                    data: {
                        type: 'TRANSFER',
                        productId: originalItem.productId,
                        locationId: originalItem.toLocationId,
                        quantity: rQty,
                        referenceId: transfer.id,
                        referenceType: 'TRANSFER_RECEIVED',
                        createdBy: userId
                    }
                });

                // 🚨 หากของหายระหว่างทาง บันทึกลง Log ความปลอดภัย
                if (rQty < originalItem.shippedQty) {
                    const diff = originalItem.shippedQty - rQty;
                    logActivity(req, `ตรวจพบสินค้าสูญหายระหว่างโอนย้าย (${transfer.transferNo}): หายไป ${diff} ชิ้น`, "Security", transfer.id, true);
                }
            }
        });

        res.json({ success: true, message: "รับสินค้าเข้าคลังปลายทางเรียบร้อยแล้ว" });
    } catch (error) {
        logger.error("[Transfer] Receive Error", { error: error.message });
        res.status(400).json({ success: false, message: error.message || "เกิดข้อผิดพลาดในการรับสินค้า" });
    }
};

const getTransferHistory = async (req, res, next) => {
    try {
        const transfers = await prisma.stockTransfer.findMany({
            include: {
                issuedUser: { select: { firstName: true, lastName: true } }, // 💡 ดึงชื่อคนส่ง
                receivedUser: { select: { firstName: true, lastName: true } }, // 💡 ดึงชื่อคนรับ
                _count: { select: { items: true } } // 💡 นับจำนวนรายการ
            },
            orderBy: { createdAt: 'desc' } // เอาล่าสุดขึ้นก่อน
        });

        // 💡 ส่งกลับในรูปแบบที่ระบบคาดหวัง { success: true, data: [...] }
        res.json({ success: true, data: transfers });
    } catch (error) {
        logger.error("[Transfer] History Error", { error: error.message });
        res.status(500).json({ success: false, message: "ไม่สามารถดึงประวัติการโอนย้ายได้" });
    }
};
const getTransferById = async (req, res, next) => {
    try {
        const { id } = req.params;
        const transfer = await prisma.stockTransfer.findUnique({
            where: { id: id },
            include: {
                issuedUser: { select: { firstName: true, lastName: true } },
                receivedUser: { select: { firstName: true, lastName: true } },
                items: {
                    include: {
                        product: true,
                        // 💡 ดึงข้อมูลคลังและโซนแบบละเอียดตามที่หน้าจอต้องการ
                        fromLocation: { include: { warehouse: true, zone: true } }, 
                        toLocation: { include: { warehouse: true, zone: true } }
                    }
                }
            }
        });

        if (!transfer) {
            return res.status(404).json({ success: false, message: "ไม่พบข้อมูลใบโอนย้าย" });
        }

        res.json({ success: true, data: transfer });
    } catch (error) {
        logger.error("[Transfer] Get Detail Error", { error: error.message });
        res.status(500).json({ success: false, message: "เกิดข้อผิดพลาดในการดึงข้อมูลรายละเอียด" });
    }
};
// อย่าลืม Export ให้ครบ
module.exports = {
    listPendingTransfers,
    shipTransfer,
    receiveTransfer,
    getTransferHistory,
    getTransferById
};