const { prisma } = require("../prismaClient");
const logger = require("./logger");
const { sendSecurityAlert } = require("./alertService");

async function logActivity(req, actionText, resource, resourceId = null, highPriority = false) {
    try {
        const traceId = req.requestId || null;
        const userId = req.user?.id || null;

        // 💡 [แก้ไข] ล้างอักขระขึ้นบรรทัดใหม่ (\n, \r) จากทุกค่าที่มาจาก Request
        const safeIp = (req.ip || "unknown").replace(/[\r\n]/g, '');
        const safePath = (req.originalUrl || "system").replace(/[\r\n]/g, '');
        const safeMethod = (req.method || "SYSTEM").replace(/[\r\n]/g, '');
        const safeUserAgent = (req.headers["user-agent"] || "unknown").replace(/[\r\n]/g, '');
        const safeAction = typeof actionText === 'string' ? actionText.replace(/[\r\n]/g, '') : actionText;

        // 💡 1. แมปข้อมูลโดยใช้ค่าที่ผ่านการ Sanitize แล้วทั้งหมด
        const data = {
            userId: userId,
            action: safeAction, // 👈 ใช้ตัวแปรที่ปลอดภัยแล้ว
            resource: resource,
            resourceId: resourceId?.toString() || null,
            method: safeMethod, // 👈 ใช้ตัวแปรที่ปลอดภัยแล้ว
            path: safePath,     // 👈 ใช้ตัวแปรที่ปลอดภัยแล้ว
            statusCode: req.res ? req.res.statusCode : 200,
            ip: safeIp,         // 👈 ใช้ตัวแปรที่ปลอดภัยแล้ว
            userAgent: safeUserAgent, // 👈 ใช้ตัวแปรที่ปลอดภัยแล้ว
            requestId: traceId,
            meta: req.auditMeta || {}
        };

        // 💡 2. พ่นลงไฟล์ Log (คราวนี้จะปลอดภัย 100% ในสายตา CodeQL)
        logger.info(`[AUDIT] ${safeAction}`, data);

        // 💡 3. ระบบแจ้งเตือน
        if (highPriority || resource === "Security" || safeAction.includes("ล้มเหลว")) {
            sendSecurityAlert(safeAction, { ip: safeIp, userId, path: safePath, reqId: traceId });
        }

        // 💡 4. บันทึกลงตาราง AuditLog
        if (highPriority) {
            await prisma.auditLog.create({ data }).catch(e => logger.error("DB Log Error:", { err: e.message }));
        } else {
            prisma.auditLog.create({ data }).catch(e => logger.error("DB Log Error:", { err: e.message }));
        }
    } catch (error) {
        logger.error("❌ [Audit Service Error]:", { error: error.message });
    }
}

module.exports = { logActivity };