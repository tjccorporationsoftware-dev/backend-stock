const { prisma } = require('../../prismaClient');
const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer');
const { format } = require('date-fns');
const bwipjs = require('bwip-js');
const { logActivity } = require('../../utils/auditService'); // 💡 [เพิ่ม]
const logger = require('../../utils/logger'); // 💡 [เพิ่ม] นำเข้า Logger

// 💡 1. สร้างรูปบาร์โค้ดสดๆ ไม่ต้องดึงจาก URL (แก้ปัญหารูปหาย 100%)
async function generateBarcode(sku) {
    try {
        if (!sku) return null;
        const buffer = await bwipjs.toBuffer({
            bcid: 'code128',       // ชนิดบาร์โค้ด
            text: sku,             // ข้อความที่จะทำบาร์โค้ด (ใช้ SKU)
            scale: 3,              // ขนาด
            height: 10,            // ความสูง
            includetext: true,     // แสดงตัวเลขใต้บาร์โค้ด
            textxalign: 'center',  // จัดกึ่งกลาง
        });
        return buffer;
    } catch (err) {
        // 💡 [อัปเกรด] บันทึก Error ลงไฟล์
        logger.error("[Reports] Barcode Gen Error", { error: err.message, sku });
        return null;
    }
}

const buildWhereCondition = (query) => {
    const { search, warehouseId, zoneId, categoryId } = query;
    const where = {};
    if (warehouseId || zoneId) {
        where.location = {};
        if (warehouseId) where.location.warehouseId = warehouseId;
        if (zoneId) where.location.zoneId = zoneId;
    }
    if (categoryId) where.product = { categoryId };
    if (search) {
        where.OR = [
            { product: { sku: { contains: search.trim(), mode: 'insensitive' } } },
            { product: { name: { contains: search.trim(), mode: 'insensitive' } } }
        ];
    }
    return where;
};

// =========================================================================
// 📊 1. Export Excel (รายงานยอดคงเหลือ - ฟอร์มทางการ + สรุปยอดด้านล่าง)
// =========================================================================
const exportInventoryExcel = async (req, res) => {
    try {
        const where = buildWhereCondition(req.query);
        const items = await prisma.stockBalance.findMany({
            where,
            include: {
                product: { include: { category: true, unit: true } },
                location: { include: { warehouse: true, zone: true } }
            },
            orderBy: { updatedAt: 'desc' }
        });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('ทะเบียนทรัพย์สินคงคลัง');

        // HEADER
        worksheet.mergeCells('A1:G1');
        worksheet.getCell('A1').value = 'บริษัท ทีเจซี คอร์ปอเรชั่น จำกัด (TJC CORPORATION CO., LTD.)';
        worksheet.getCell('A1').font = { size: 16, bold: true };
        worksheet.getCell('A1').alignment = { horizontal: 'center' };

        worksheet.mergeCells('A2:G2');
        worksheet.getCell('A2').value = 'รายงานทะเบียนทรัพย์สินคงคลัง (Inventory Asset Registry Report)';
        worksheet.getCell('A2').font = { size: 14, bold: true };
        worksheet.getCell('A2').alignment = { horizontal: 'center' };

        worksheet.mergeCells('A3:G3');
        worksheet.getCell('A3').value = `วันที่พิมพ์เอกสาร: ${format(new Date(), 'dd/MM/yyyy HH:mm')} น.`;
        worksheet.getCell('A3').font = { size: 10, italic: true };
        worksheet.getCell('A3').alignment = { horizontal: 'right' };

        worksheet.addRow([]);

        // TABLE HEADER
        const headerRow = worksheet.addRow([
            'รหัสสินค้า (SKU)', 'ชื่อทรัพย์สิน (Asset Description)', 'บาร์โค้ด (Identity)',
            'สถานที่จัดเก็บ (Placement)', 'จำนวน (Qty)', 'ราคา/หน่วย (Cost)', 'มูลค่ารวม (Net Value)'
        ]);

        headerRow.height = 25;
        headerRow.eachCell((cell) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });

        worksheet.columns = [
            { key: 'sku', width: 20 }, { key: 'name', width: 45 }, { key: 'barcode', width: 35 },
            { key: 'loc', width: 30 }, { key: 'qty', width: 12 }, { key: 'cost', width: 15 }, { key: 'total', width: 20 },
        ];

        let sumQty = 0;
        let sumValue = 0;

        // DATA ROWS
        for (let i = 0; i < items.length; i++) {
            const b = items[i];
            const rowIdx = i + 6;
            const placement = `${b.location.warehouse?.code || '-'} | ${b.location.zone?.code || '-'} | ${b.location.code || '-'}`;
            const itemVal = Number(b.quantity) * Number(b.product.unitCost || 0);

            sumQty += Number(b.quantity);
            sumValue += itemVal;

            const row = worksheet.addRow({
                sku: b.product.sku,
                name: b.product.name,
                loc: placement,
                qty: b.quantity,
                cost: b.product.unitCost,
                total: itemVal
            });

            row.height = 65;
            row.eachCell((cell, colNumber) => {
                cell.alignment = { vertical: 'middle', horizontal: (colNumber >= 5) ? 'right' : 'left' };
                cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            });
            row.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
            row.getCell(6).numFmt = '#,##0.00';
            row.getCell(7).numFmt = '#,##0.00';

            // สร้างรูปบาร์โค้ดและฝังลง Excel ทันที
            const barcodeBuffer = await generateBarcode(b.product.sku);
            if (barcodeBuffer) {
                const imgId = workbook.addImage({ buffer: barcodeBuffer, extension: 'png' });
                worksheet.addImage(imgId, {
                    tl: { col: 2, row: rowIdx - 1 }, ext: { width: 200, height: 60 }, editAs: 'oneCell'
                });
            }
        }

        // 💡 บรรทัดสรุปผล (Grand Total) สำหรับยอดคงเหลือ
        const totalRow = worksheet.addRow(['', '', '', 'รวมยอดคงเหลือทั้งสิ้น (Grand Total):', sumQty, '', sumValue]);
        worksheet.mergeCells(`A${totalRow.number}:D${totalRow.number}`);
        totalRow.height = 30;

        const labelCell = totalRow.getCell(1);
        labelCell.alignment = { vertical: 'middle', horizontal: 'right' };
        labelCell.font = { bold: true, size: 12 };

        totalRow.getCell(5).font = { bold: true, size: 12 };
        totalRow.getCell(5).alignment = { vertical: 'middle', horizontal: 'center' };
        totalRow.getCell(5).border = { bottom: { style: 'double' } };

        totalRow.getCell(7).font = { bold: true, size: 12, color: { argb: 'FF16A34A' } };
        totalRow.getCell(7).alignment = { vertical: 'middle', horizontal: 'right' };
        totalRow.getCell(7).numFmt = '฿#,##0.00';
        totalRow.getCell(7).border = { bottom: { style: 'double' } };

        const buffer = await workbook.xlsx.writeBuffer();

        // 💡 บันทึก Log การนำข้อมูลออก
        logActivity(req, `ส่งออกรายงานทะเบียนทรัพย์สินคงคลัง (Excel) จำนวน ${items.length} รายการ`, "Reports", null, false);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Inventory_Balance_Report_${format(new Date(), 'yyyyMMdd')}.xlsx"`);
        res.setHeader('Content-Length', buffer.length);

        return res.status(200).send(buffer);

    } catch (error) {
        logger.error("[Reports] Excel Export Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: "Excel Generation Failed" });
    }
};

// =========================================================================
// 📄 2. Export PDF (รายงานยอดคงเหลือ - ฟอร์มทางการ)
// =========================================================================
const exportInventoryPDF = async (req, res) => {
    let browser;
    try {
        const where = buildWhereCondition(req.query);
        const items = await prisma.stockBalance.findMany({
            where,
            include: {
                product: { include: { category: true, unit: true } },
                location: { include: { warehouse: true, zone: true } }
            },
            orderBy: { updatedAt: 'desc' }
        });

        const tableRows = await Promise.all(items.map(async (b, index) => {
            const placement = `${b.location.warehouse?.code || '-'} | ${b.location.zone?.code || '-'} | ${b.location.code || '-'}`;
            const barcodeBuffer = await generateBarcode(b.product.sku);
            const imgSrc = barcodeBuffer ? `data:image/png;base64,${barcodeBuffer.toString('base64')}` : '';
            const totalVal = (Number(b.quantity) * Number(b.product.unitCost || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 });

            return `
                <tr>
                    <td align="center">${index + 1}</td>
                    <td style="font-weight: bold; color: #1e293b;">${b.product.sku}</td>
                    <td>${b.product.name}</td>
                    <td align="center">
                        ${imgSrc ? `<img class="barcode-img" src="${imgSrc}" />` : '-'}
                    </td>
                    <td>${placement}</td>
                    <td align="center"><b>${b.quantity}</b></td>
                    <td align="right">฿${totalVal}</td>
                </tr>
            `;
        }));

        const html = `
            <!DOCTYPE html>
            <html lang="th">
            <head>
                <meta charset="UTF-8">
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap');
                    body { font-family: 'Sarabun', sans-serif; padding: 30px; color: #0f172a; }
                    .header-container { border-bottom: 2px solid #1e293b; padding-bottom: 15px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: flex-end; }
                    .company-name { margin: 0; font-size: 20px; font-weight: 800; color: #0f172a; }
                    .report-title { margin: 5px 0 0 0; font-size: 14px; font-weight: bold; color: #475569; }
                    .meta-info { font-size: 11px; color: #64748b; text-align: right; line-height: 1.5; }
                    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
                    th { background: #1e293b; color: white; border: 1px solid #cbd5e1; padding: 10px 5px; font-size: 11px; text-align: center; }
                    td { border: 1px solid #cbd5e1; padding: 8px 5px; font-size: 11px; vertical-align: middle; }
                    .barcode-img { height: 45px; width: auto; display: block; margin: 0 auto; }
                    .footer { position: fixed; bottom: 20px; left: 30px; right: 30px; display: flex; justify-content: space-between; font-size: 10px; color: #94a3b8; border-top: 1px solid #e2e8f0; padding-top: 10px; }
                </style>
            </head>
            <body>
                <div class="header-container">
                    <div>
                        <h1 class="company-name">บริษัท ทีเจซี คอร์ปอเรชั่น จำกัด</h1>
                        <p class="report-title">รายงานทะเบียนทรัพย์สินคงคลัง (Inventory Asset Registry Report)</p>
                    </div>
                    <div class="meta-info">
                        <b>วันที่จัดพิมพ์:</b> ${format(new Date(), 'dd/MM/yyyy')}<br/>
                        <b>เวลา:</b> ${format(new Date(), 'HH:mm')} น.<br/>
                        <b>จำนวนรายการรวม:</b> ${items.length} รายการ
                    </div>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th width="5%">ลำดับ</th>
                            <th width="15%">รหัสสินค้า (SKU)</th>
                            <th width="25%">ชื่อทรัพย์สิน</th>
                            <th width="20%">บาร์โค้ดอ้างอิง</th>
                            <th width="15%">สถานที่จัดเก็บ</th>
                            <th width="8%">จำนวน</th>
                            <th width="12%">มูลค่ารวม</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows.join('')}
                    </tbody>
                </table>
                <div class="footer">
                    <div>เอกสารรับรองโดย TJC Enterprise Inventory System</div>
                    <div>หน้า 1 ของ 1 (อัตโนมัติ)</div>
                </div>
            </body>
            </html>
        `;

        browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'load' });

        const pdfBuffer = await page.pdf({
            format: 'A4', printBackground: true,
            margin: { top: '15mm', bottom: '20mm', left: '10mm', right: '10mm' }
        });

        // 💡 บันทึก Log การนำข้อมูลออก
        logActivity(req, `ส่งออกรายงานทะเบียนทรัพย์สินคงคลัง (PDF) จำนวน ${items.length} รายการ`, "Reports", null, false);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="Inventory_Balance_Report_${format(new Date(), 'yyyyMMdd')}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);

        return res.status(200).send(pdfBuffer);

    } catch (error) {
        logger.error("[Reports] PDF Export Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: "PDF Generation Failed" });
    } finally {
        if (browser) await browser.close();
    }
};


// 📈 Export Movement Excel (ประวัติความเคลื่อนไหว - แปลงเลข UUID เป็นชื่อจริง)
const exportMovementExcel = async (req, res) => {
    try {
        const { type, startDate, endDate, warehouseId } = req.query;

        // 1. สร้างเงื่อนไขกรองข้อมูล
        const whereCondition = {};
        if (type && type !== 'ALL') whereCondition.type = type;
        if (startDate || endDate) {
            whereCondition.createdAt = {};
            if (startDate) whereCondition.createdAt.gte = new Date(`${startDate}T00:00:00Z`);
            if (endDate) whereCondition.createdAt.lte = new Date(`${endDate}T23:59:59Z`);
        }
        if (warehouseId) {
            whereCondition.location = { warehouseId };
        }

        // 2. ดึงประวัติทั้งหมด (เอา include user ออกเพื่อแก้ Error 500)
        const movements = await prisma.stockMovement.findMany({
            where: whereCondition,
            take: 50000,
            include: {
                product: { select: { sku: true, name: true, unitCost: true } },
                location: { select: { code: true, warehouse: { select: { code: true, name: true } }, zone: { select: { code: true } } } }
            },
            orderBy: { createdAt: 'asc' }
        });

        // 💡 [อัปเกรด Security] ดักจับพฤติกรรมการดูดข้อมูล (Data Scraping) ถ้ายอดดึงทะลุเพดาน
        if (movements.length === 50000) {
            logger.warn(`[Reports] Data Scraping Alert: มีการดึงข้อมูล Movement เต็มโควต้าสูงสุด (50,000 รายการ) อาจมีความพยายามดึงข้อมูลบริษัทออกทั้งหมด`, {
                ip: req.ip,
                userId: req.user?.id
            });
        }

        // 💡 3. ระบบจับคู่ชื่อผู้ใช้งาน (ดึง User ทั้งหมดมาจำไว้ใน Memory ป้องกันการ Crash)
        const userMap = {};
        try {
            const users = await prisma.user.findMany(); // ดึงจากตาราง User
            users.forEach(u => {
                // นำชื่อ-นามสกุลมารวมกัน ถ้าไม่มีให้ใช้ Username หรือเบอร์โทร
                userMap[u.id] = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.username || u.id;
            });
        } catch (e) {
            logger.error("[Reports] User Map Linking Error", { error: e.message });
        }

        // 💡 4. ระบบจับคู่เลขที่เอกสารอ้างอิง (Inbound / Outbound)
        const refMap = {};
        try {
            const inbounds = await prisma.inbound.findMany();
            inbounds.forEach(i => { refMap[i.id] = i.documentNo || i.id; });
        } catch (e) { }

        try {
            const outbounds = await prisma.outbound.findMany();
            outbounds.forEach(o => { refMap[o.id] = o.documentNo || o.id; });
        } catch (e) { }


        // 5. สร้างไฟล์ Excel
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('ประวัติความเคลื่อนไหว');

        // HEADER
        worksheet.mergeCells('A1:J1');
        worksheet.getCell('A1').value = 'บริษัท ทีเจซี คอร์ปอเรชั่น จำกัด (TJC CORPORATION CO., LTD.)';
        worksheet.getCell('A1').font = { size: 16, bold: true };
        worksheet.getCell('A1').alignment = { horizontal: 'center' };

        worksheet.mergeCells('A2:J2');
        worksheet.getCell('A2').value = 'รายงานประวัติความเคลื่อนไหวสินค้า (Inventory Movement Ledger)';
        worksheet.getCell('A2').font = { size: 14, bold: true };
        worksheet.getCell('A2').alignment = { horizontal: 'center' };

        worksheet.mergeCells('A3:J3');
        worksheet.getCell('A3').value = `วันที่พิมพ์: ${format(new Date(), 'dd/MM/yyyy HH:mm')} น. | เงื่อนไข: ${startDate || 'เริ่มต้น'} ถึง ${endDate || 'ปัจจุบัน'} | ประเภท: ${type || 'ทั้งหมด'}`;
        worksheet.getCell('A3').font = { size: 10, italic: true };
        worksheet.getCell('A3').alignment = { horizontal: 'center' };
        worksheet.addRow([]);

        // TABLE HEADER
        const headerRow = worksheet.addRow([
            'วัน-เวลา (Date/Time)', 'รหัสอ้างอิง (Ref. ID)', 'ประเภท (Type)',
            'รหัสสินค้า (SKU)', 'ชื่อสินค้า (Description)', 'สถานที่จัดเก็บ (Placement)',
            'จำนวน (Qty)', 'ราคา/หน่วย (Cost)', 'มูลค่ารวม (Total Value)', 'ผู้ทำรายการ (User)'
        ]);

        headerRow.height = 25;
        headerRow.eachCell((cell) => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E293B' } };
            cell.alignment = { vertical: 'middle', horizontal: 'center' };
            cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
        });

        worksheet.columns = [
            { key: 'date', width: 22 }, { key: 'refId', width: 25 }, { key: 'type', width: 15 },
            { key: 'sku', width: 20 }, { key: 'name', width: 40 }, { key: 'loc', width: 30 },
            { key: 'qty', width: 12 }, { key: 'cost', width: 15 }, { key: 'total', width: 18 }, { key: 'user', width: 25 }
        ];

        let sumInQty = 0, sumInVal = 0;
        let sumOutQty = 0, sumOutVal = 0;
        let sumAdjQty = 0, sumAdjVal = 0;

        // DATA ROWS
        for (let i = 0; i < movements.length; i++) {
            const item = movements[i];

            const qty = Number(item.quantity || 0);
            const cost = Number(item.product?.unitCost || 0);
            const totalVal = qty * cost;

            // กำหนดสีและเก็บยอดรวม
            let typeColor = 'FF000000';
            let typeText = item.type;
            if (item.type === 'IN') { typeColor = 'FF16A34A'; typeText = 'รับเข้า (IN)'; sumInQty += qty; sumInVal += totalVal; }
            else if (item.type === 'OUT') { typeColor = 'FFDC2626'; typeText = 'เบิกออก (OUT)'; sumOutQty += qty; sumOutVal += totalVal; }
            else if (item.type === 'ADJUST') { typeColor = 'FFCA8A04'; typeText = 'ปรับปรุง (ADJUST)'; sumAdjQty += qty; sumAdjVal += totalVal; }

            // 💡 นำ UUID ไปแปลงเป็น "ชื่อจริง" และ "เลขที่เอกสาร" 
            const realUserName = userMap[item.createdBy] || item.createdBy || '-';
            const realRefId = refMap[item.referenceId] || item.referenceId || '-';

            const placement = `${item.location?.warehouse?.code || '-'} | ${item.location?.zone?.code || '-'} | ${item.location?.code || '-'}`;

            const row = worksheet.addRow({
                date: format(new Date(item.createdAt), 'dd/MM/yyyy HH:mm:ss'),
                refId: realRefId,     // แสดงเลขที่เอกสารแทน UUID
                type: typeText,
                sku: item.product.sku,
                name: item.product.name,
                loc: placement,
                qty: qty,
                cost: cost,
                total: totalVal,
                user: realUserName    // แสดงชื่อจริงแทน UUID
            });

            row.getCell(3).font = { bold: true, color: { argb: typeColor } };
            row.getCell(7).font = { bold: true };
            row.getCell(7).alignment = { horizontal: 'center' };
            row.getCell(8).numFmt = '#,##0.00';
            row.getCell(9).numFmt = '#,##0.00';
            row.getCell(10).alignment = { horizontal: 'center' };

            row.eachCell((cell) => {
                cell.alignment = cell.alignment || { vertical: 'middle' };
                cell.border = { top: { style: 'thin' }, left: { style: 'thin' }, bottom: { style: 'thin' }, right: { style: 'thin' } };
            });
        }

        // บรรทัดสรุปข้อมูล (Summary Rows)
        worksheet.addRow([]);

        const addSummaryRow = (label, totalQty, totalValue, colorHex) => {
            const sumRow = worksheet.addRow(['', '', '', '', '', label, totalQty, '', totalValue, '']);
            worksheet.mergeCells(`A${sumRow.number}:F${sumRow.number}`);

            const labelCell = sumRow.getCell(1);
            labelCell.alignment = { horizontal: 'right', vertical: 'middle' };
            labelCell.font = { bold: true, size: 12 };

            sumRow.getCell(7).font = { bold: true, size: 12, color: { argb: colorHex } };
            sumRow.getCell(7).alignment = { horizontal: 'center' };

            sumRow.getCell(9).font = { bold: true, size: 12, color: { argb: colorHex } };
            sumRow.getCell(9).numFmt = '฿#,##0.00';
        };

        if (type === 'ALL' || type === 'IN') addSummaryRow('สรุปรวมรับเข้าทั้งหมด (Total IN):', sumInQty, sumInVal, 'FF16A34A');
        if (type === 'ALL' || type === 'OUT') addSummaryRow('สรุปรวมเบิกออกทั้งหมด (Total OUT):', sumOutQty, sumOutVal, 'FFDC2626');
        if (type === 'ALL' || type === 'ADJUST') addSummaryRow('สรุปรวมปรับปรุงทั้งหมด (Total ADJUST):', sumAdjQty, sumAdjVal, 'FFCA8A04');

        const buffer = await workbook.xlsx.writeBuffer();

        // 💡 บันทึก Log การนำข้อมูลออก
        logActivity(req, `ส่งออกรายงานประวัติความเคลื่อนไหว (Excel) จำนวน ${movements.length} รายการ`, "Reports", null, false);

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="Movement_Ledger_Report_${format(new Date(), 'yyyyMMdd')}.xlsx"`);
        res.setHeader('Content-Length', buffer.length);

        return res.status(200).send(buffer);

    } catch (error) {
        logger.error("[Reports] Movement Export Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: "Movement Generation Failed" });
    }
};

module.exports = {
    exportInventoryExcel,
    exportInventoryPDF,
    exportMovementExcel
};