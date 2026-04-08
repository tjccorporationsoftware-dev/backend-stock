const { prisma } = require('../../prismaClient');
const { logActivity } = require('../../utils/auditService');
const logger = require('../../utils/logger');
const puppeteer = require('puppeteer');


// 1. สร้างใบสั่งตรวจนับ (Create Count Task)
const createCountTask = async (req, res, next) => {
    try {
        const { warehouseId, zoneId, remarks } = req.body;
        const userId = req.user.id;

        // ดึงรายการสินค้าที่มีสต๊อกอยู่ในคลัง/โซนที่เลือก
        const balances = await prisma.stockBalance.findMany({
            where: {
                location: {
                    warehouseId: warehouseId || undefined,
                    zoneId: zoneId || undefined
                }
            },
            include: { product: true, location: true }
        });

        if (balances.length === 0) {
            return res.status(400).json({ success: false, message: "ไม่พบสินค้าคงคลังในเงื่อนไขที่ระบุ" });
        }

        const task = await prisma.$transaction(async (tx) => {
            // สร้างเลขที่เอกสาร CNT-YYYYMMDD-XXX
            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
            const countToday = await tx.countTask.count({ where: { taskNo: { startsWith: `CNT-${dateStr}` } } });
            const taskNo = `CNT-${dateStr}-${String(countToday + 1).padStart(3, '0')}`;

            return await tx.countTask.create({
                data: {
                    taskNo,
                    status: 'PENDING', // PENDING -> COUNTING -> REVIEW -> COMPLETED
                    remarks,
                    createdBy: userId,
                    items: {
                        create: balances.map(b => ({
                            productId: b.productId,
                            locationId: b.locationId,
                            systemQty: b.quantity, // Snapshot ยอดระบบ ณ เวลานั้น
                        }))
                    }
                },
                include: { items: true }
            });
        });

        logActivity(req, `สร้างใบสั่งตรวจนับสต๊อก: ${task.taskNo} (${task.items.length} รายการ)`, "CountTask", task.id, false);
        res.status(201).json({ success: true, data: task });
    } catch (error) {
        logger.error("[CountTask] Create Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

// 2. บันทึกยอดที่นับได้ (รองรับทั้ง สแกนทีละตัว และ คีย์รวดเดียวผ่านเว็บ)
const saveCountData = async (req, res, next) => {
    try {
        const { id } = req.params; // ID ของ CountTask
        const { items } = req.body; // รับเป็น Array [{ itemId: "...", countedQty: 10 }]

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "กรุณาส่งข้อมูลการนับ" });
        }

        await prisma.$transaction(async (tx) => {
            // อัปเดตสถานะเป็นกำลังนับ (ถ้ายังเป็น PENDING)
            await tx.countTask.updateMany({
                where: { id, status: 'PENDING' },
                data: { status: 'COUNTING' }
            });

            // วนลูปอัปเดตยอดนับจริงทีละรายการ
            for (const item of items) {
                const countItem = await tx.countTaskItem.findUnique({ where: { id: item.itemId } });
                if (countItem) {
                    await tx.countTaskItem.update({
                        where: { id: item.itemId },
                        data: {
                            countedQty: item.countedQty,
                            diffQty: item.countedQty - countItem.systemQty, // คำนวณส่วนต่างทันที
                            scannedAt: new Date()
                        }
                    });
                }
            }
        });

        res.json({ success: true, message: "บันทึกข้อมูลการนับสำเร็จ" });
    } catch (error) {
        logger.error("[CountTask] Save Data Error", { error: error.message, ip: req.ip });
        next(error);
    }
};

// 3. หัวหน้ากดยืนยัน (เปลี่ยนสถานะ และไปเรียกการ Adjust Stock อัตโนมัติ)
const completeCountTask = async (req, res, next) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const task = await prisma.countTask.findUnique({
            where: { id },
            include: { items: true }
        });

        if (!task || task.status === 'COMPLETED') {
            return res.status(400).json({
                success: false,
                message: "เอกสารนี้ไม่พร้อมให้อนุมัติ หรือถูกอนุมัติไปแล้ว"
            });
        }

        const diffItems = task.items.filter(
            it => it.countedQty !== null && Number(it.diffQty) !== 0
        );

        await prisma.$transaction(async (tx) => {
            await tx.countTask.update({
                where: { id },
                data: {
                    status: 'COMPLETED',
                    completedAt: new Date()
                }
            });

            for (const it of diffItems) {
                await tx.stockBalance.updateMany({
                    where: {
                        productId: it.productId,
                        locationId: it.locationId
                    },
                    data: {
                        quantity: it.countedQty,
                        updatedAt: new Date()
                    }
                });

                await tx.stockMovement.create({
                    data: {
                        type: 'ADJUST',
                        productId: it.productId,
                        locationId: it.locationId,
                        quantity: it.diffQty,
                        referenceId: task.id,
                        referenceType: 'COUNT_TASK',
                        createdBy: userId
                    }
                });
            }
        });

        res.json({
            success: true,
            message: "ปิดใบสั่งนับและปรับยอดจาก CNT สำเร็จ"
        });
    } catch (error) {
        next(error);
    }
};

// 4. ดึงข้อมูลทั้งหมด (สำหรับ List & Detail)
const listCountTasks = async (req, res, next) => {
    try {
        const tasks = await prisma.countTask.findMany({
            include: {
                creator: {
                    select: {
                        firstName: true,
                        lastName: true
                    }
                },
                _count: {
                    select: {
                        items: true
                    }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json({
            success: true,
            data: tasks
        });
    } catch (error) {
        logger.error("[CountTask] List Error", {
            error: error.message,
            ip: req.ip,
            userId: req.user?.id
        });
        next(error);
    }
};

const getCountTaskDetail = async (req, res, next) => {
    try {
        const task = await prisma.countTask.findUnique({
            where: { id: req.params.id },
            include: {
                creator: {
                    select: {
                        firstName: true,
                        lastName: true
                    }
                },
                items: {
                    include: {
                        product: true,
                        location: {
                            include: {
                                zone: true,
                                warehouse: true
                            }
                        }
                    }
                }
            }
        });

        res.json({ success: true, data: task });
    } catch (error) {
        next(error);
    }
};
const generateCountTaskPDF = async (req, res, next) => {
    try {
        const { id } = req.params;

        // ดึงข้อมูล Task พร้อมข้อมูลที่เกี่ยวข้องทั้งหมด
        const task = await prisma.countTask.findUnique({
            where: { id },
            include: {
                creator: { select: { firstName: true, lastName: true } },
                items: {
                    include: {
                        product: { include: { unit: true } },
                        location: { include: { warehouse: true, zone: true } }
                    },
                    orderBy: [
                        { location: { warehouseId: 'asc' } },
                        { location: { zoneId: 'asc' } },
                        { location: { code: 'asc' } }
                    ]
                }
            }
        });

        if (!task) return res.status(404).json({ message: "ไม่พบข้อมูลใบสั่งนับ" });

        // ดึงข้อมูลบริษัท
        const company = await prisma.companySettings.findUnique({ where: { id: "main-config" } });
        const companyName = company?.name || "บริษัท ทีเจซี กรุ๊ป จำกัด";

        // สร้าง HTML สำหรับ PDF
        let htmlContent = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>ใบสั่งตรวจนับสินค้าคงคลัง</title>
            <style>
                @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap');
                body {
                    font-family: 'Sarabun', sans-serif;
                    padding: 30px;
                    color: #1e293b;
                    font-size: 13px;
                }
                .header { text-align: center; margin-bottom: 30px; }
                .company-name { font-size: 22px; font-weight: bold; margin-bottom: 5px; }
                .doc-title { font-size: 18px; font-weight: bold; text-decoration: underline; margin-bottom: 20px; }
                .info-table { width: 100%; margin-bottom: 20px; border: none; }
                .info-table td { padding: 4px 0; vertical-align: top; }
                .info-label { font-weight: bold; width: 120px; }
                
                .data-table { width: 100%; border-collapse: collapse; margin-bottom: 30px; }
                .data-table th, .data-table td { border: 1px solid #cbd5e1; padding: 8px 10px; }
                .data-table th { background-color: #f1f5f9; font-weight: bold; text-align: center; }
                .text-center { text-align: center; }
                .text-right { text-align: right; }
                
                .signature-section { margin-top: 50px; width: 100%; display: table; }
                .sig-box { display: table-cell; width: 50%; text-align: center; }
                .sig-line { margin: 0 auto 10px auto; width: 200px; border-bottom: 1px solid #64748b; height: 50px; }
            </style>
        </head>
        <body>
            <div class="header">
                <div class="company-name">${companyName}</div>
                <div class="doc-title">ใบสั่งตรวจนับสินค้าคงคลัง (Physical Count Sheet)</div>
            </div>

            <table class="info-table">
                <tr>
                    <td class="info-label">เลขที่เอกสาร:</td>
                    <td><strong>${task.taskNo}</strong></td>
                    <td class="info-label">วันที่สั่งพิมพ์:</td>
                    <td>${new Date().toLocaleDateString('th-TH', { year: 'numeric', month: 'long', day: 'numeric' })}</td>
                </tr>
                <tr>
                    <td class="info-label">ผู้สั่งการ (หัวหน้า):</td>
                    <td>${task.creator?.firstName || ''} ${task.creator?.lastName || ''}</td>
                    <td class="info-label">หมายเหตุ:</td>
                    <td>${task.remarks || '-'}</td>
                </tr>
            </table>

            <table class="data-table">
                <thead>
                    <tr>
                        <th width="5%">ลำดับ</th>
                        <th width="15%">รหัสตำแหน่ง<br>(Location)</th>
                        <th width="20%">รหัสสินค้า<br>(SKU)</th>
                        <th width="30%">ชื่อสินค้า<br>(Product Name)</th>
                        <th width="10%">ยอดระบบ<br>(System)</th>
                        <th width="10%">หน่วย</th>
                        <th width="10%">ยอดนับจริง<br>(Actual)</th>
                    </tr>
                </thead>
                <tbody>
        `;

        task.items.forEach((item, index) => {
            htmlContent += `
                    <tr>
                        <td class="text-center">${index + 1}</td>
                        <td class="text-center">${item.location?.code || '-'}</td>
                        <td class="text-center"><strong>${item.product?.sku || '-'}</strong></td>
                        <td>${item.product?.name || '-'}</td>
                        <td class="text-center">${item.systemQty}</td>
                        <td class="text-center">${item.product?.unit?.name || 'PCS'}</td>
                        <td></td> </tr>
            `;
        });

        htmlContent += `
                </tbody>
            </table>

            <div class="signature-section">
                <div class="sig-box">
                    <div class="sig-line"></div>
                    <div>( ........................................................... )</div>
                    <div style="margin-top: 5px;">ผู้ตรวจนับสต๊อกหน้างาน</div>
                    <div style="margin-top: 5px;">วันที่ ....... / ....... / ...........</div>
                </div>
                <div class="sig-box">
                    <div class="sig-line"></div>
                    <div>( ........................................................... )</div>
                    <div style="margin-top: 5px;">ผู้ตรวจสอบ / แอดมินคีย์ข้อมูล</div>
                    <div style="margin-top: 5px;">วันที่ ....... / ....... / ...........</div>
                </div>
            </div>
        </body>
        </html>
        `;

        // สร้าง PDF ด้วย Puppeteer
        const browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
            margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
        });
        await browser.close();

        // ส่งไฟล์ PDF กลับไป
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="CountSheet_${task.taskNo}.pdf"`);
        res.send(pdfBuffer);

    } catch (error) {
        logger.error("[CountTask] Generate PDF Error", { error: error.message });
        next(error);
    }
};
const deleteCountTask = async (req, res, next) => {
    try {
        const { id } = req.params;

        const task = await prisma.countTask.findUnique({
            where: { id }
        });

        if (!task) {
            return res.status(404).json({ success: false, message: "ไม่พบเอกสารนี้ในระบบ" });
        }

        // 💡 ป้องกันการลบเอกสารที่เสร็จแล้ว
        if (task.status === 'COMPLETED') {
            logActivity(req, `พยายามลบใบสั่งนับที่ปรับยอดเสร็จแล้ว (Task: ${task.taskNo})`, "Security", id, true);
            return res.status(400).json({ success: false, message: "ไม่อนุญาตให้ลบเอกสารที่อนุมัติและปรับยอดสต๊อกไปแล้ว" });
        }

        // ลบเอกสาร (Cascade จะลบ CountTaskItem อัตโนมัติ)
        await prisma.countTask.delete({ where: { id } });

        logActivity(req, `ลบใบสั่งตรวจนับสต๊อก: ${task.taskNo}`, "CountTask", id, false);
        res.json({ success: true, message: "ลบเอกสารใบสั่งตรวจนับสำเร็จ" });

    } catch (error) {
        logger.error("[CountTask] Delete Error", { error: error.message, ip: req.ip });
        next(error);
    }
};

module.exports = {
    createCountTask,
    saveCountData,
    completeCountTask,
    listCountTasks,
    getCountTaskDetail,
    generateCountTaskPDF,
    deleteCountTask
};