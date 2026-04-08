const { prisma } = require('../../prismaClient');
const { logActivity } = require('../../utils/auditService');
const logger = require('../../utils/logger'); // 💡 [เพิ่ม] นำเข้า Logger

const createStockRequisition = async (req, res, next) => {
    try {
        const { srNumber, purpose, departmentId, priority, requiredDate, referenceNo, deliveryLocation, remarks, items } = req.body;
        const userId = req.user.id;

        // [SECURITY]: ป้องกันรายการว่างและการกรอกจำนวนติดลบ
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "ต้องระบุสินค้าอย่างน้อย 1 รายการ" });
        }
        if (items.some(it => Number(it.quantity) <= 0)) {
            // 💡 [อัปเกรด Security] ดักจับยอดเบิกติดลบ
            logActivity(req, `พยายามสร้างใบขอเบิกสินค้า (SR) ด้วยยอดติดลบหรือศูนย์`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนสินค้าต้องมากกว่า 0" });
        }

        const requisition = await prisma.$transaction(async (tx) => {
            const existingSR = await tx.stockRequisition.findUnique({ where: { srNumber } });
            if (existingSR) throw new Error("เลขที่ใบขอเบิกนี้มีในระบบแล้ว");

            return await tx.stockRequisition.create({
                data: {
                    srNumber: srNumber.trim(),
                    purpose: purpose.trim(),
                    departmentId: departmentId || null,
                    priority: priority || 'NORMAL',
                    requiredDate: requiredDate ? new Date(requiredDate) : null,
                    referenceNo: referenceNo?.trim() || null,
                    deliveryLocation: deliveryLocation?.trim() || null,
                    remarks: remarks?.trim() || null,
                    requestedBy: userId,
                    status: 'PENDING',
                    items: {
                        create: items.map(it => ({
                            productId: it.productId,
                            quantity: Number(it.quantity),
                            remark: it.remark?.trim() || null
                        }))
                    }
                }
            });
        });

        logActivity(req, `สร้างใบขอเบิกสินค้า (SR) เลขที่: ${srNumber}`, "Inventory_Requisition", requisition.id);
        res.status(201).json({ success: true, message: "สร้างใบขอเบิกสินค้าสำเร็จ กรุณารอหัวหน้างานอนุมัติ" });
    } catch (error) {
        logger.error("[Outbound] Create SR Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: error.message });
    }
};

const getPendingRequisitions = async (req, res, next) => {
    try {
        const requisitions = await prisma.stockRequisition.findMany({
            where: { status: 'PENDING' },
            include: {
                user: { select: { firstName: true, lastName: true } },
                department: { select: { name: true } },
                items: {
                    include: {
                        product: {
                            select: {
                                sku: true,
                                name: true,
                                unitCost: true // 💡 เพิ่มบรรทัดนี้ เพื่อให้ส่งราคาไปที่หน้าเว็บ
                            }
                        }
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json(requisitions);
    } catch (error) {
        logger.error("[Outbound] Pending SR Fetch Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const updateRequisitionStatus = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { status } = req.body;
        const userId = req.user.id;

        if (!['APPROVED', 'REJECTED'].includes(status)) {
            return res.status(400).json({ success: false, message: "สถานะไม่ถูกต้อง" });
        }

        // [SECURITY]: ป้องกันการอนุมัติใบเบิกของตนเอง
        const reqDoc = await prisma.stockRequisition.findUnique({ where: { id } });
        if (!reqDoc) return res.status(404).json({ success: false, message: "ไม่พบใบขอเบิก" });

        if (reqDoc.requestedBy === userId && status === 'APPROVED') {
            // 💡 [อัปเกรด Security] เรื่องนี้ซีเรียสมาก! ยิง LINE แจ้งเตือนพฤติกรรมพยายามอนุมัติให้ตัวเองทันที (ทุจริต)
            logActivity(req, `พยายามอนุมัติใบเบิกสินค้า (SR) ของตนเอง! (ID: ${id})`, "Security", id, true);
            return res.status(403).json({ success: false, message: "เพื่อความโปร่งใส ไม่อนุญาตให้อนุมัติใบเบิกของตนเองได้" });
        }

        const updatedReq = await prisma.stockRequisition.update({
            where: { id },
            data: {
                status,
                approvedBy: status === 'APPROVED' ? userId : null
            }
        });

        const actionText = status === 'APPROVED' ? 'อนุมัติ' : 'ปฏิเสธ';
        logActivity(req, `${actionText}ใบขอเบิกสินค้า เลขที่: ${updatedReq.srNumber}`, "Inventory_Approval", id);
        res.status(200).json({ success: true, message: `ทำรายการ${actionText}ใบเบิกสำเร็จ` });
    } catch (error) {
        logger.error("[Outbound] Update SR Status Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: "เกิดข้อผิดพลาดในการเปลี่ยนสถานะ" });
    }
};

const listRequisitions = async (req, res, next) => {
    try {
        const { status } = req.query;
        const requisitions = await prisma.stockRequisition.findMany({
            where: status ? { status } : undefined,
            include: {
                user: { select: { firstName: true, lastName: true } },
                department: { select: { name: true } },
                approver: { select: { firstName: true, lastName: true } },
                _count: { select: { items: true } },
                items: { include: { product: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.status(200).json(requisitions);
    } catch (error) {
        logger.error("[Outbound] List Requisitions Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: "ไม่สามารถดึงข้อมูลใบเบิกได้" });
    }
};

const createDeliveryOrder = async (req, res, next) => {
    try {
        const { doNo, reference, remarks, items, srId } = req.body;
        const userId = req.user.id;

        // [SECURITY]: ป้องกันรายการว่างและการกรอกจำนวนติดลบ
        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "ต้องระบุสินค้าอย่างน้อย 1 รายการ" });
        }
        if (items.some(item => Number(item.quantity) <= 0)) {
            // 💡 [อัปเกรด Security] ดักจับจ่ายของยอดติดลบ
            logActivity(req, `พยายามสร้างใบจ่ายของ (DO) ด้วยยอดติดลบหรือศูนย์`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนสินค้าต้องมากกว่า 0" });
        }

        const result = await prisma.$transaction(async (tx) => {
            for (const item of items) {
                const qty = Number(item.quantity);
                const balance = await tx.stockBalance.findUnique({
                    where: { productId_locationId: { productId: item.productId, locationId: item.locationId } }
                });

                if (!balance || balance.quantity < qty) {
                    const product = await tx.product.findUnique({ where: { id: item.productId } });
                    throw new Error(`สินค้า ${product?.sku || item.productId} ในตำแหน่งที่เลือกมีไม่เพียงพอ (คงเหลือ: ${balance?.quantity || 0})`);
                }
            }
            const deliveryOrder = await tx.deliveryOrder.create({
                data: {
                    doNo, reference: reference || null, remarks: remarks || null, issuedBy: userId, srId: srId || null,
                    items: {
                        create: items.map(item => ({
                            productId: item.productId,
                            locationId: item.locationId,
                            quantity: Number(item.quantity)
                        }))
                    }
                }
            });
            const movements = items.map(item => ({
                type: 'OUT',
                productId: item.productId,
                locationId: item.locationId,
                quantity: Number(item.quantity),
                referenceId: deliveryOrder.id,
                referenceType: 'DELIVERY_ORDER',
                createdBy: userId
            }));
            await tx.stockMovement.createMany({ data: movements });

            for (const item of items) {
                // 💡 [เสริมความชัวร์ระดับ Database]: ใช้เงื่อนไข { decrement } ควบคู่การเช็คยอดก่อนหน้า
                await tx.stockBalance.update({
                    where: { productId_locationId: { productId: item.productId, locationId: item.locationId } },
                    data: { quantity: { decrement: Number(item.quantity) } }
                });
            }
            if (srId) {
                await tx.stockRequisition.update({
                    where: { id: srId },
                    data: { status: 'DISPATCHED' }
                });
            }
            return deliveryOrder;
        });

        logActivity(req, `สร้างใบจ่ายสินค้า: ${result.doNo} (${items.length} รายการ)`, "Outbound", result.id);
        res.status(201).json({ success: true, message: "จ่ายสินค้าและตัดสต๊อกสำเร็จ", data: result });
    } catch (error) {
        logger.error("[Outbound] Create DO Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: error.message });
    }
};

const listDeliveryOrders = async (req, res, next) => {
    try {
        const rows = await prisma.deliveryOrder.findMany({
            include: {
                user: { select: { firstName: true, lastName: true } },
                _count: { select: { items: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(rows);
    } catch (error) {
        logger.error("[Outbound] List DO Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

const getDeliveryOrderDetail = async (req, res, next) => {
    try {
        const { id } = req.params;
        const row = await prisma.deliveryOrder.findUnique({
            where: { id },
            include: {
                user: { select: { firstName: true, lastName: true } }, // เจ้าหน้าที่คลังผู้จ่าย
                requisition: {
                    include: {
                        // 💡 [จุดสำคัญ] ต้องมีบรรทัดนี้ แผนกถึงจะแสดง
                        department: { select: { name: true } },
                        user: { select: { firstName: true, lastName: true } }, // ผู้ขอเบิก
                        approver: { select: { firstName: true, lastName: true } } // ผู้อนุมัติ
                    }
                },
                items: {
                    include: {
                        product: {
                            include: { unit: true } // ดึงหน่วยนับและ unitCost (ปกติจะมากับก้อน product)
                        },
                        location: {
                            include: {
                                warehouse: { select: { name: true, code: true } }, // 💡 ดึงชื่อคลังแบบเต็ม
                                zone: { select: { name: true, code: true } }      // 💡 ดึงชื่อโซนแบบเต็ม
                            }
                        }
                    }
                }
            }
        });

        if (!row) {
            return res.status(404).json({ message: "ไม่พบข้อมูลใบนำจ่าย" });
        }

        res.json(row);
    } catch (error) {
        next(error);
    }
};
// 💡 ฟังก์ชันใหม่ที่รัดกุมกว่าเดิม (แก้ไขเอา price ออกแล้ว)
const getDepartmentConsumption = async (req, res, next) => {
    try {
        // 1. ดึงข้อมูลใบเบิก "ทุกสถานะ" ที่ไม่ใช่ ยกเลิก(CANCELLED) หรือ รออนุมัติ(PENDING)
        const requisitions = await prisma.stockRequisition.findMany({
            where: {
                status: { notIn: ['PENDING', 'REJECTED', 'CANCELLED'] }
            },
            include: {
                department: { select: { name: true } },
                user: { include: { department: { select: { name: true } } } },
                items: {
                    include: {
                        // 🚨 แก้ตรงนี้: ลบ price: true ออก ดึงแค่ unitCost ตัวเดียว
                        product: { select: { unitCost: true } }
                    }
                }
            }
        });

        const deptMap = {};

        requisitions.forEach(sr => {
            // หาชื่อแผนก (จากหัวบิล -> จากคนสร้าง -> Default)
            const deptName = sr.department?.name || sr.user?.department?.name || 'ส่วนกลาง (General)';

            let srValue = 0;

            if (sr.items && Array.isArray(sr.items)) {
                sr.items.forEach(item => {
                    const qty = Number(item.quantity) || 0;
                    const cost = Number(item.product?.unitCost) || 1;

                    srValue += (qty * cost);
                });
            }

            if (!deptMap[deptName]) {
                deptMap[deptName] = 0;
            }
            deptMap[deptName] += srValue;
        });

        const formattedData = Object.keys(deptMap)
            .map(name => ({ name, value: deptMap[name] }))
            .filter(item => item.value > 0)
            .sort((a, b) => b.value - a.value)
            .slice(0, 5);

        res.json({ success: true, data: formattedData });
    } catch (error) {
        logger.error("[Outbound] Dept Consumption Error", { error: error.message, ip: req.ip });
        next(error);
    }
};

module.exports = {
    createStockRequisition, getPendingRequisitions, updateRequisitionStatus,
    listRequisitions, createDeliveryOrder, listDeliveryOrders, getDeliveryOrderDetail,
    getDepartmentConsumption
};