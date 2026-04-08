const { prisma } = require("../prismaClient");
const logger = require("./logger");
const { sendSecurityAlert } = require("./alertService");

async function logActivity(req, actionText, resource, resourceId = null, highPriority = false) {
    try {
        const traceId = req.requestId || null; // ดึงมาจาก requestIdMiddleware
        const userId = req.user?.id || null;
        const ip = req.ip || "unknown";
        const path = req.originalUrl || "system";
        const method = req.method || "SYSTEM";

        // 💡 1. แมปข้อมูลให้ตรงกับตาราง AuditLog ใน Schema เป๊ะๆ
        const data = {
            userId: userId,
            action: actionText,
            resource: resource,
            resourceId: resourceId?.toString() || null,
            method: method,
            path: path,
            statusCode: req.res ? req.res.statusCode : 200,
            ip: ip,
            userAgent: req.headers["user-agent"] || "unknown",
            requestId: traceId, // เก็บ ID ไว้ตามสืบ
            meta: req.auditMeta || {} // เผื่ออยากแนบ JSON อะไรเพิ่ม
        };

        // 💡 2. พ่นลงไฟล์ Log เสมอ
        logger.info(`[AUDIT] ${actionText}`, data);

        // 💡 3. ระบบแจ้งเตือน (ถ้าระบุว่าสำคัญ หรือเป็นเรื่องความปลอดภัย)
        if (highPriority || resource === "Security" || actionText.includes("ล้มเหลว")) {
            sendSecurityAlert(actionText, { ip, userId, path, reqId: traceId });
        }

        // 💡 4. บันทึกลงตาราง AuditLog ใน Database
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