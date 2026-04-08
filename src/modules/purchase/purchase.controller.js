const { prisma } = require('../../prismaClient');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { logActivity } = require('../../utils/auditService');
const logger = require('../../utils/logger'); // 💡 [เพิ่ม] นำเข้า Logger
const EXPORT_DIR = path.resolve(__dirname, '../../public/exports/pdfs');

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'pos');
const UPLOAD_DIR_PR = path.join(process.cwd(), 'public', 'uploads', 'prs');

// ==========================================
// 1. สร้างใบขออนุมัติสั่งซื้อ (Create PR)
// ==========================================
const createPR = async (req, res, next) => {
    try {
        const { purpose, departmentId, supplierId, items } = req.body;
        const userId = req.user.id;

        if (!items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "ต้องระบุสินค้าอย่างน้อย 1 รายการ" });
        }

        // 💡 [อัปเกรด Security] ดักจับการกรอกจำนวนหรือราคาประเมินติดลบ (Logic Flaw)
        if (items.some(item => Number(item.quantity) <= 0 || Number(item.estimatedPrice) < 0)) {
            logActivity(req, `พยายามสร้าง PR ด้วยจำนวนติดลบ/ศูนย์ หรือราคาติดลบ`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนและราคาต้องถูกต้องและไม่ติดลบ" });
        }

        const pr = await prisma.$transaction(async (tx) => {
            const now = new Date();
            const yearMonth = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
            const prefix = `PR-${yearMonth}-`;

            const lastPr = await tx.purchaseRequisition.findFirst({
                where: { prNumber: { startsWith: prefix } },
                orderBy: { prNumber: 'desc' },
                select: { prNumber: true }
            });

            let nextNum = 1;
            if (lastPr && lastPr.prNumber) {
                const lastPart = lastPr.prNumber.replace(prefix, '');
                nextNum = parseInt(lastPart, 10) + 1;
            }
            const prNumber = `${prefix}${String(nextNum).padStart(4, '0')}`;

            return await tx.purchaseRequisition.create({
                data: {
                    prNumber,
                    purpose,
                    departmentId: departmentId || null,
                    supplierId: supplierId || null,
                    requestedBy: userId,
                    status: 'PENDING',
                    items: {
                        create: items.map(item => ({
                            productId: item.productId,
                            quantity: Number(item.quantity),
                            estimatedPrice: Number(item.estimatedPrice) || 0
                        }))
                    }
                }
            });
        });

        logActivity(req, `สร้างใบขอซื้อ (PR) เลขที่: ${pr.prNumber}`, "Purchase", pr.id);
        res.status(201).json({ success: true, message: "ส่งใบขอซื้อให้ผู้จัดการพิจารณาแล้ว", data: pr });
    } catch (error) {
        logger.error("[Purchase] Create PR Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: "เกิดข้อผิดพลาดในการสร้างข้อมูล" });
    }
};

// ==========================================
// 2. เรียกดูรายการใบขอซื้อ (List PRs)
// ==========================================
const listPRs = async (req, res, next) => {
    try {
        const { status, unused } = req.query;
        let whereClause = {};

        // ค้นหาตามสถานะที่ระบุ เช่น ?status=APPROVED
        if (status) {
            whereClause.status = status;
        }

        // 💡 [สำคัญมาก]: ถ้าใส่ ?unused=true แปลว่าเอาเฉพาะ PR ที่ยังไม่เคยโดนแปลงเป็น PO (เหมาะสำหรับหน้าฝ่ายจัดซื้อ)
        if (unused === 'true') {
            whereClause.purchaseOrders = { none: {} }; // ห้ามมี PO ผูกอยู่เลย
        }

        const prs = await prisma.purchaseRequisition.findMany({
            where: whereClause,
            include: {
                user: { select: { firstName: true, lastName: true } },
                department: { select: { name: true } },
                supplier: { select: { name: true, code: true, phone: true } },
                purchaseOrders: { select: { poNumber: true, pdfPath: true } },
                items: {
                    include: { product: { select: { sku: true, name: true } } }
                },
                approvals: {
                    include: { approver: { select: { firstName: true, lastName: true } } },
                    orderBy: { actedAt: 'desc' }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(prs);
    } catch (error) {
        logger.error("[Purchase] List PRs Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: "ไม่สามารถดึงข้อมูลใบขอซื้อได้" });
    }
};


// ==========================================
// 3. ดูรายละเอียดใบขอซื้อ (Detail)
// ==========================================
const getPRDetail = async (req, res, next) => {
    try {
        const { id } = req.params;
        const pr = await prisma.purchaseRequisition.findUnique({
            where: { id },
            include: {
                user: { select: { firstName: true, lastName: true } },
                department: { select: { name: true } },
                supplier: { select: { name: true, code: true, phone: true } },
                items: { include: { product: { select: { sku: true, name: true } } } },
                approvals: {
                    include: {
                        approver: { select: { firstName: true, lastName: true } }
                    },
                    orderBy: { actedAt: 'desc' }
                }
            }
        });

        if (!pr) {
            logger.warn(`[Purchase] พยายามดูข้อมูล PR ที่ไม่มีอยู่จริง (ID: ${id})`, { ip: req.ip, userId: req.user?.id });
            return res.status(404).json({ message: "ไม่พบใบขอซื้อนี้" });
        }
        let approverData = null;
        if (pr.approvals && pr.approvals.length > 0) {
            const latestApproval = pr.approvals.find(a => a.status === 'APPROVED') || pr.approvals[0];
            if (latestApproval && latestApproval.approver) {
                approverData = {
                    firstName: latestApproval.approver.firstName,
                    lastName: latestApproval.approver.lastName,
                    signature: latestApproval.signature
                };
            }
        }
        const responseData = {
            ...pr,
            approver: approverData
        };

        res.json(responseData);

    } catch (error) {
        logger.error("[Purchase] PR Detail Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        next(error);
    }
};

// ==========================================
// 4. อนุมัติใบขอซื้อปกติ (Approve/Reject)
// ==========================================
const approvePR = async (req, res, next) => {
    try {
        const id = req.params?.id || req.body?.id;
        const { status, comments } = req.body;
        const result = await prisma.$transaction(async (tx) => {
            const updatedPr = await tx.purchaseRequisition.update({ where: { id }, data: { status } });
            await tx.prApproval.create({
                data: { prId: id, approverId: req.user.id, status, comments, actedAt: new Date() }
            });
            return updatedPr;
        });
        res.json({ success: true, message: "ดำเนินการสำเร็จ", data: result });
    } catch (error) {
        logger.error("[Purchase] Approve PR Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(400).json({ success: false, message: error.message });
    }
};

// ==========================================
// 🚀 5. อนุมัติ + สร้าง PO + เจน PDF (แม่นยำสูง + ดึงชื่อผู้อนุมัติ)
// ==========================================
const executeApproveAndIssuePO = async (req, res) => {
    let browser;
    try {
        const { prId } = req.params;
        const { poNumber, vendorName, supplierId, items, comments, signatureBase64, totalAmount } = req.body;
        const approverId = req.user.id;

        // 💡 [อัปเกรด Security] ดักจับจำนวน/ราคาติดลบ เพื่อป้องกันทุจริตยักยอกเงิน PO
        if (items && items.some(it => Number(it.orderedQuantity) <= 0 || Number(it.unitPrice) < 0)) {
            logActivity(req, `พยายามสร้าง PO ด้วยจำนวน/ราคาติดลบในขั้นตอนอนุมัติ (Logic Flaw)`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนและราคาการสั่งซื้อต้องไม่ติดลบ" });
        }

        const [pr, approverData, company] = await Promise.all([
            prisma.purchaseRequisition.findUnique({
                where: { id: prId },
                include: { user: true, department: true }
            }),
            prisma.user.findUnique({
                where: { id: approverId },
                select: { firstName: true, lastName: true }
            })
        ]);

        if (!pr || pr.status !== 'PENDING') return res.status(400).json({ message: "ใบขอซื้อไม่พร้อมสำหรับการอนุมัติ" });

        const approverFullname = `${approverData.firstName} ${approverData.lastName}`;

        if (!fs.existsSync(UPLOAD_DIR)) {
            fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        }
        const safePoNumber = path.basename(poNumber);
        const fileName = `${safePoNumber}.pdf`;
        const filePath = path.join(UPLOAD_DIR, fileName);

        const htmlTemplate = `
            <!DOCTYPE html>
            <html lang="th">
            <head>
                <meta charset="UTF-8">
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;700&display=swap');
                    body { font-family: 'Sarabun', sans-serif; color: #1e293b; padding: 40px; line-height: 1.5; }
                    .header { text-align: center; border-bottom: 3px double #0f172a; padding-bottom: 15px; margin-bottom: 30px; }
                    .company-name { font-size: 26px; font-weight: 700; color: #0f172a; margin: 0; }
                    .document-title { font-size: 16px; font-weight: 700; margin-top: 5px; color: #475569; }
                    .info-grid { display: table; width: 100%; margin-bottom: 25px; font-size: 13px; }
                    .info-col { display: table-cell; width: 50%; vertical-align: top; }
                    .text-right { text-align: right; }
                    .purpose-box { background-color: #f8fafc; border-left: 4px solid #0f172a; padding: 12px; margin-bottom: 20px; font-size: 13px; }
                    table { width: 100%; border-collapse: collapse; margin-bottom: 30px; font-size: 13px; }
                    th { background-color: #f1f5f9; border: 1px solid #cbd5e1; padding: 10px; text-align: center; font-weight: 700; }
                    td { border: 1px solid #cbd5e1; padding: 8px 10px; }
                    .total-row { font-weight: 700; background-color: #f8fafc; }
                    .footer-section { margin-top: 40px; }
                    .signature-wrapper { float: right; text-align: center; width: 280px; margin-top: 20px; }
                    .sig-img { max-height: 70px; max-width: 180px; margin-bottom: 5px; }
                    .signature-line { border-top: 1px solid #0f172a; padding-top: 5px; font-weight: 700; font-size: 13px; }
                    .approver-name { font-size: 13px; margin-top: 2px; font-weight: 400; }
                    .verification-tag { font-size: 10px; color: #10b981; margin-top: 4px; font-weight: 700; }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1 class="company-name">TJC GROUP</h1>
                    <div class="document-title">ใบสั่งซื้อและหลักฐานการอนุมัติ (PURCHASE ORDER)</div>
                </div>
                <div class="info-grid">
                    <div class="info-col">
                        <p><strong>เลขที่ใบสั่งซื้อ:</strong> ${poNumber}</p>
                        <p><strong>อ้างอิงใบขอซื้อ:</strong> ${pr.prNumber}</p>
                        <p><strong>หน่วยงาน/แผนก:</strong> ${pr.department?.name || 'ฝ่ายปฏิบัติการ'}</p>
                    </div>
                    <div class="info-col text-right">
                        <p><strong>วันที่:</strong> ${new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })}</p>
                        <p><strong>ผู้ขอเบิก:</strong> ${pr.user.firstName} ${pr.user.lastName}</p>
                        <p><strong>คู่ค้า:</strong> ${vendorName}</p>
                    </div>
                </div>
                <div class="purpose-box"><strong>วัตถุประสงค์:</strong> ${pr.purpose}</div>
                <table>
                    <thead>
                        <tr>
                            <th style="width: 40px;">#</th>
                            <th>รายการสินค้า/บริการ</th>
                            <th style="width: 60px;">จำนวน</th>
                            <th style="width: 100px;">ราคาต่อหน่วย</th>
                            <th style="width: 110px;">ยอดรวม</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${items.map((item, index) => `
                            <tr>
                                <td style="text-align: center;">${index + 1}</td>
                                <td>${item.productName}</td>
                                <td style="text-align: center;">${item.orderedQuantity}</td>
                                <td style="text-align: right;">${Number(item.unitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                <td style="text-align: right;">${(item.orderedQuantity * item.unitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                            </tr>
                        `).join('')}
                        <tr class="total-row">
                            <td colspan="4" style="text-align: right;">จำนวนเงินรวมทั้งสิ้น (Grand Total)</td>
                            <td style="text-align: right;">฿${Number(totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                        </tr>
                    </tbody>
                </table>
                <div class="footer-section">
                    <div style="font-size: 13px;"><strong>หมายเหตุ:</strong> ${comments || 'อนุมัติตามเสนอ'}</div>
                    <div class="signature-wrapper">
                        <div style="height: 70px;"><img src="${signatureBase64}" class="sig-img" /></div>
                        <div class="signature-line">( ${approverFullname} )</div>
                        <div class="approver-name">ผู้อนุมัติสั่งซื้อ</div>
                        <div class="verification-tag">✓ Digitally Signed & System Verified</div>
                    </div>
                </div>
            </body>
            </html>
        `;

        browser = await puppeteer.launch({ headless: "new", args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(htmlTemplate, { waitUntil: 'networkidle0' });
        await page.pdf({ path: filePath, format: 'A4', printBackground: true });
        await browser.close();

        const finalResult = await prisma.$transaction(async (tx) => {
            await tx.purchaseRequisition.update({ where: { id: prId }, data: { status: 'APPROVED' } });
            await tx.prApproval.create({ data: { prId, approverId, status: 'APPROVED', comments, actedAt: new Date() } });
            return await tx.purchaseOrder.create({
                data: {
                    poNumber, vendorName, supplierId, orderedBy: approverId, prId, status: 'PENDING',
                    pdfPath: `/uploads/pos/${fileName}`,
                    items: { create: items.map(it => ({ productId: it.productId, orderedQuantity: Number(it.orderedQuantity), unitPrice: Number(it.unitPrice) })) }
                }
            });
        });

        logActivity(req, `อนุมัติ PR และสร้าง PDF PO: ${poNumber}`, "Executive_Action", finalResult.id);
        res.json({ success: true, pdfUrl: `/uploads/pos/${fileName}` });

    } catch (error) {
        if (browser) await browser.close();
        logger.error("[Purchase] Execute PO Creation Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: error.message });
    }
};

// ==========================================
// 🔒 6. ระบบเปิดดูเอกสาร (Secure Document Viewer)
// ==========================================
const viewPODocument = (req, res) => {
    try {
        const { filename } = req.params;

        // 💡 [อัปเกรด Security] ดักจับการเจาะระบบขโมยดูไฟล์ (Path Traversal) แล้วยิง LINE ทันที
        if (filename.includes('..') || filename.includes('/')) {
            logActivity(req, `พยายามเจาะระบบอ่านไฟล์ PO นอกระบบ (Path Traversal): ${filename}`, "Security", null, true);
            const safeFilename = filename.replace(/[\r\n]/g, '');
            logger.warn(`[Security] Path Traversal Attempt: ${safeFilename}`, { ip: req.ip, userId: req.user?.id });
            return res.status(403).send("Forbidden");
        }

        const filePath = path.join(UPLOAD_DIR, filename);

        if (fs.existsSync(filePath)) {
            res.contentType("application/pdf");
            return res.sendFile(filePath);
        } else {
            const safeFilename = filename.replace(/[\r\n]/g, '');
            logger.warn(`[Security] Path Traversal Attempt: ${safeFilename}`, { ip: req.ip, userId: req.user?.id });
            return res.status(404).json({ message: "ไม่พบไฟล์เอกสารบนเซิร์ฟเวอร์" });
        }
    } catch (error) {
        logger.error("[Purchase] View PO Document Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: "ระบบประมวลผลไฟล์ล้มเหลว" });
    }
};

const approvePRWithPDF = async (req, res) => {
    let browser;
    try {
        const { prId } = req.params;
        const { status, comments, signatureBase64 } = req.body;
        const approverId = req.user.id;

        // 💡 1. ดึงข้อมูล PR, ผู้บริหาร และ ข้อมูลบริษัท
        const [pr, approver, company] = await Promise.all([
            prisma.purchaseRequisition.findUnique({
                where: { id: prId },
                include: {
                    user: { select: { firstName: true, lastName: true } },
                    department: true,
                    items: { include: { product: true } }
                }
            }),
            prisma.user.findUnique({
                where: { id: approverId },
                select: { firstName: true, lastName: true }
            }),
            prisma.companySettings.findUnique({ where: { id: "main-config" } })
        ]);

        if (!pr || pr.status !== 'PENDING') return res.status(400).json({ message: "คำขอนี้ถูกดำเนินการไปแล้ว" });

        const approverFullname = `${approver.firstName} ${approver.lastName}`;
        const totalAmount = pr.items.reduce((sum, item) => sum + (Number(item.quantity) * Number(item.estimatedPrice)), 0);

        if (!fs.existsSync(UPLOAD_DIR_PR)) fs.mkdirSync(UPLOAD_DIR_PR, { recursive: true });
        const safePrNumber = path.basename(pr.prNumber);
        const fileName = `${safePrNumber}.pdf`;
        const filePath = path.join(UPLOAD_DIR_PR, fileName);

        // 💡 2. เตรียมข้อมูลบริษัท
        const companyName = company?.name || "บริษัท ทีเจซี คอร์ปอเรชั่น จำกัด";
        const companyBranch = company?.branch ? `(${company.branch})` : "";
        const companyAddress = company?.address
            ? `${company.address} ${company.subDistrict} ${company.district} ${company.province} ${company.zipCode}`
            : "311/1 หมู่ 4 ตำบลคำน้ำแซบ อำเภอวารินชำราบ จังหวัดอุบลราชธานี 34190";
        const companyTaxId = company?.taxId ? `<p><strong>เลขประจำตัวผู้เสียภาษี:</strong> ${company.taxId}</p>` : "";
        const logoHtml = company?.logoUrl ? `<img src="${company.logoUrl}" style="max-height: 60px; margin-bottom: 10px;" />` : "";

        // 💡 3. แปะลง HTML Template
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
                    .company-logo img { max-height: 65px; max-width: 140px; object-fit: contain; margin-bottom: 0 !important; }
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
                    .sig-img { max-height: 65px; max-width: 170px; }
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
                            <h2>ใบขออนุมัติสั่งซื้อ (PR)</h2>
                            <div class="doc-no">No. ${pr.prNumber}</div>
                        </div>
                    </div>
                    <div class="info-section">
                        <div class="info-box">
                            <span class="label">แผนกที่ร้องขอ / Department</span>
                            <div style="font-weight: 700; font-size: 14px; margin-bottom: 8px;">${pr.department?.name || 'ส่วนกลาง'}</div>
                            <span class="label">วัตถุประสงค์โครงการ / Purpose</span>
                            <div style="font-size: 12px; color: #334155;">${pr.purpose || '-'}</div>
                        </div>
                        <div class="info-box-right">
                            <p><span class="label">วันที่ขอ / Date</span> 
                               ${new Date(pr.createdAt).toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })}
                            </p>
                            <p><span class="label">ผู้ขอซื้อ / Requester</span>
                               ${pr.user.firstName} ${pr.user.lastName}
                            </p>
                        </div>
                    </div>
                    <div class="table-wrapper">
                        <table>
                            <thead>
                                <tr>
                                    <th style="width: 50px;">ลำดับ</th>
                                    <th style="text-align: left;">รายการสินค้า / Description</th>
                                    <th style="width: 80px;">จำนวน</th>
                                    <th style="width: 110px;">ราคาประเมิน</th>
                                    <th style="width: 130px;">ยอดรวมประเมิน</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${pr.items.map((item, index) => `
                                    <tr class="item-row">
                                        <td style="text-align: center;">${index + 1}</td>
                                        <td style="font-weight: 700;">${item.product?.name || item.productId}</td>
                                        <td style="text-align: center;">${item.quantity.toLocaleString()}</td>
                                        <td style="text-align: right;">${Number(item.estimatedPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td style="text-align: right; font-weight: 700;">${(item.quantity * item.estimatedPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                    </tr>
                                `).join('')}
                                <tr class="empty-row"><td></td><td></td><td></td><td></td><td></td></tr>
                                <tr class="total-row">
                                    <td colspan="4" style="text-align: right; padding-right: 15px;">งบประมาณประเมินรวมทั้งสิ้น (Grand Total)</td>
                                    <td style="text-align: right; color: #4f46e5;">฿${totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="remarks-section">
                        <span class="label">หมายเหตุการอนุมัติ / Approval Note:</span>
                        <div style="line-height: 1.6;">${comments || 'อนุมัติตามที่เสนอมา'}</div>
                    </div>
                    <div class="footer-signatures">
                        <div class="sig-block">
                            <div class="sig-image-wrap">
                                ${signatureBase64
                ? `<img src="${signatureBase64}" class="sig-img" />`
                : `<div style="color: #cbd5e1; font-style: italic; font-size: 11px; margin-bottom: 10px;">Authorized Digitally</div>`
            }
                            </div>
                            <div class="sig-line"></div>
                            <div class="sig-name">( ${approverFullname} )</div>
                            <div class="sig-title">ผู้อนุมัติ (Authorized Executive)</div>
                            <div class="verified-tag">SYSTEM VERIFIED</div>
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

        await prisma.$transaction(async (tx) => {
            await tx.purchaseRequisition.update({
                where: { id: prId },
                data: { status: 'APPROVED', pdfPath: `/uploads/prs/${fileName}` }
            });

            await tx.prApproval.create({
                data: {
                    prId, approverId, status: 'APPROVED', comments, actedAt: new Date(), signature: signatureBase64
                }
            });
        });

        res.json({ success: true, pdfUrl: `/uploads/prs/${fileName}` });

    } catch (error) {
        if (browser) await browser.close();
        logger.error("[Purchase] Approve PR with PDF Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: error.message });
    }
};

const createPOFromPR = async (req, res) => {
    let browser;
    try {
        const { prId, poNumber, vendorName, supplierId, items, status, procurementSignature, note, deliveryLocation } = req.body;
        const procurementId = req.user.id;

        // 💡 [อัปเกรด Security] ดักจับการแก้ไขรายการ PO ให้ติดลบก่อนเจน PDF
        if (items && items.some(it => Number(it.orderedQuantity) <= 0 || Number(it.unitPrice) < 0)) {
            logActivity(req, `พยายามสร้าง PO จาก PR ด้วยจำนวน/ราคาติดลบ (Logic Flaw)`, "Security", null, true);
            return res.status(400).json({ success: false, message: "จำนวนและราคาการสั่งซื้อต้องไม่ติดลบ" });
        }

        const [pr, procurementUser, company] = await Promise.all([
            prisma.purchaseRequisition.findUnique({
                where: { id: prId },
                include: {
                    user: { select: { firstName: true, lastName: true } },
                    department: true,
                    approvals: {
                        where: { status: 'APPROVED' },
                        select: { signature: true, approver: { select: { firstName: true, lastName: true } } },
                        orderBy: { createdAt: 'desc' },
                        take: 1
                    }
                }
            }),
            prisma.user.findUnique({
                where: { id: procurementId },
                select: { firstName: true, lastName: true }
            }),
            prisma.companySettings.findUnique({ where: { id: "main-config" } })
        ]);

        if (!pr) return res.status(400).json({ message: "ไม่พบข้อมูลใบขอซื้ออ้างอิง" });

        const procurementFullname = `${procurementUser.firstName} ${procurementUser.lastName}`;
        const prApproval = pr.approvals?.[0];
        const prApproverName = prApproval ? `${prApproval.approver.firstName} ${prApproval.approver.lastName}` : "ผู้มีอำนาจอนุมัติ";
        const prApproverSignature = prApproval?.signature || null;

        const totalAmount = items.reduce((sum, item) => sum + (Number(item.orderedQuantity) * Number(item.unitPrice)), 0);

        const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads', 'pos');
        if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        const safePoNumber = path.basename(poNumber);
        const fileName = `${safePoNumber}.pdf`;
        const filePath = path.join(UPLOAD_DIR, fileName);

        const companyName = company?.name || "บริษัท ทีเจซี คอร์ปอเรชั่น จำกัด";
        const companyBranch = company?.branch ? `(${company.branch})` : "";
        const companyAddress = company?.address
            ? `${company.address} ${company.subDistrict} ${company.district} ${company.province} ${company.zipCode}`
            : "311/1 หมู่ 4 ตำบลคำน้ำแซบ อำเภอวารินชำราบ จังหวัดอุบลราชธานี 34190";
        const companyTaxId = company?.taxId ? `<p><strong>เลขประจำตัวผู้เสียภาษี:</strong> ${company.taxId}</p>` : "";
        const logoHtml = company?.logoUrl ? `<img src="${company.logoUrl}" style="max-height: 60px; margin-bottom: 10px;" />` : "";

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
                    .company-logo img { max-height: 65px; max-width: 140px; object-fit: contain; margin-bottom: 0 !important; }
                    .company-info h1 { margin: 0 0 5px 0; font-size: 20px; font-weight: 700; color: #0f172a; }
                    .company-info p { margin: 1px 0; font-size: 12px; color: #1e293b; line-height: 1.4; }
                    .document-title { text-align: right; }
                    .document-title h2 { margin: 0; font-size: 22px; font-weight: 700; color: #475569; }
                    .document-title .po-no { margin: 8px 0 0 0; font-size: 16px; font-weight: 700; color: #4f46e5; }
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
                    .footer-signatures { display: flex; justify-content: space-between; width: 100%; padding-bottom: 10mm; }
                    .sig-block { width: 260px; text-align: center; }
                    .sig-image-wrap { height: 65px; display: flex; align-items: flex-end; justify-content: center; margin-bottom: 8px; }
                    .sig-img { max-height: 65px; max-width: 170px; }
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
                            <h2>ใบสั่งซื้อสินค้า</h2>
                            <div class="po-no">No. ${poNumber}</div>
                        </div>
                    </div>
                    <div class="info-section">
                        <div class="info-box">
                            <span class="label">ผู้จำหน่าย / Vendor</span>
                            <div style="font-weight: 700; font-size: 14px;">${vendorName}</div>
                            <div style="margin-top: 5px; font-size: 11px; color: #64748b;">อ้างอิงใบขอซื้อ (PR): ${pr.prNumber}</div>
                        </div>
                        <div class="info-box-right">
                            <p><span class="label">วันที่ออกเอกสาร / Date</span> 
                               ${new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' })}
                            </p>
                            <p><span class="label">แผนกที่ร้องขอ / Department</span>
                               ${pr.department?.name || 'ฝ่ายปฏิบัติการ'}
                            </p>
                            <p><span class="label">สถานที่ส่งมอบ / Delivery To</span>
                               ${deliveryLocation || 'ไม่ระบุ'}
                            </p>
                        </div>
                        
                    </div>
                    <div class="table-wrapper">
                        <table>
                            <thead>
                                <tr>
                                    <th style="width: 50px;">ลำดับ</th>
                                    <th style="text-align: left;">รายการสินค้า / Description</th>
                                    <th style="width: 80px;">จำนวน</th>
                                    <th style="width: 110px;">ราคา/หน่วย</th>
                                    <th style="width: 130px;">จำนวนเงิน</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${items.map((item, index) => `
                                    <tr class="item-row">
                                        <td style="text-align: center;">${index + 1}</td>
                                        <td style="font-weight: 700;">${item.productName || 'รายการสินค้า'}</td>
                                        <td style="text-align: center;">${item.orderedQuantity.toLocaleString()}</td>
                                        <td style="text-align: right;">${Number(item.unitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                        <td style="text-align: right; font-weight: 700;">${(item.orderedQuantity * item.unitPrice).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                    </tr>
                                `).join('')}
                                <tr class="empty-row"><td></td><td></td><td></td><td></td><td></td></tr>
                                <tr class="total-row">
                                    <td colspan="4" style="text-align: right; padding-right: 15px;">ยอดรวมสุทธิ (Grand Total)</td>
                                    <td style="text-align: right; color: #4f46e5;">฿${Number(totalAmount).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="remarks-section">
                        <span class="label">หมายเหตุ / Note:</span>
                        <div style="line-height: 1.6;">${note || 'ไม่มีหมายเหตุเพิ่มเติม'}</div>
                    </div>
                    <div class="footer-signatures">
                        <div class="sig-block">
                            <div class="sig-image-wrap">
                                <img src="${procurementSignature}" class="sig-img" />
                            </div>
                            <div class="sig-line"></div>
                            <div class="sig-name">( ${procurementFullname} )</div>
                            <div class="sig-title">เจ้าหน้าที่ฝ่ายจัดซื้อ (Purchaser)</div>
                            <div class="verified-tag" style="color: #4f46e5;">E-SIGNED BY PROCUREMENT</div>
                        </div>
                        <div class="sig-block">
                            <div class="sig-image-wrap">
                                ${prApproverSignature
                ? `<img src="${prApproverSignature}" class="sig-img" />`
                : `<div style="color: #cbd5e1; font-style: italic; font-size: 11px; margin-bottom: 10px;">Authorized Digitally</div>`
            }
                            </div>
                            <div class="sig-line"></div>
                            <div class="sig-name">( ${prApproverName} )</div>
                            <div class="sig-title">ผู้อนุมัติสั่งซื้อ (Authorized Executive)</div>
                            <div class="verified-tag">OFFICIALLY APPROVED</div>
                        </div>
                    </div>
                </div>
            </body>
            </html>
        `;

        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });
        const page = await browser.newPage();
        await page.setContent(htmlTemplate, { waitUntil: 'networkidle2', timeout: 60000 });
        await page.pdf({
            path: filePath,
            format: 'A4',
            printBackground: true,
            margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' }
        });
        await browser.close();

        await prisma.purchaseOrder.create({
            data: {
                poNumber, vendorName, supplierId: supplierId || null,
                orderedBy: procurementId, prId: prId, status: status || 'ORDERED',
                pdfPath: `/uploads/pos/${fileName}`,
                items: { create: items.map(it => ({ productId: it.productId, orderedQuantity: Number(it.orderedQuantity), unitPrice: Number(it.unitPrice) })) }
            }
        });

        res.json({ success: true, message: "สร้างใบสั่งซื้อ PO และ PDF เรียบร้อย", pdfUrl: `/uploads/pos/${fileName}` });

    } catch (error) {
        if (browser) await browser.close();
        logger.error("[Purchase] Create PO from PR Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: error.message });
    }
};

// ฟังก์ชันเปิดดูเอกสาร PR แบบ Secure
const viewPRDocument = (req, res) => {
    try {
        const { filename } = req.params;

        // 💡 [อัปเกรด Security] ดักจับการเจาะระบบอ่านไฟล์นอกระบบ
        if (filename.includes('..') || filename.includes('/')) {
            logActivity(req, `พยายามเจาะระบบอ่านไฟล์ PR นอกระบบ (Path Traversal): ${filename}`, "Security", null, true);
            const safeFilename = filename.replace(/[\r\n]/g, '');
            logger.warn(`[Security] Path Traversal Attempt: ${safeFilename}`, { ip: req.ip, userId: req.user?.id });
            return res.status(403).send("Forbidden");
        }

        const filePath = path.join(UPLOAD_DIR_PR, filename);

        if (fs.existsSync(filePath)) {
            res.contentType("application/pdf");
            return res.sendFile(filePath);
        }

        logger.warn(`[Purchase] พยายามเปิดไฟล์ PR ที่ไม่มีอยู่จริง: ${filename}`, { ip: req.ip, userId: req.user?.id });
        res.status(404).json({ message: "ไม่พบไฟล์เอกสาร" });
    } catch (error) {
        logger.error("[Purchase] View PR Document Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: "ระบบประมวลผลไฟล์ล้มเหลว" });
    }
};

module.exports = {
    createPR, listPRs, getPRDetail, approvePR,
    executeApproveAndIssuePO, viewPODocument, createPOFromPR,
    approvePRWithPDF, viewPRDocument
};