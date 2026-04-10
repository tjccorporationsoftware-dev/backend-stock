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

        const data = {
            userId: userId,
            action: safeAction,
            resource: resource,
            resourceId: resourceId?.toString() || null,
            method: safeMethod,
            path: safePath, 
            statusCode: req.res ? req.res.statusCode : 200,
            ip: safeIp,
            userAgent: safeUserAgent,
            requestId: traceId,
            meta: req.auditMeta || {}
        };
        logger.info(`[AUDIT] ${safeAction}`, data);
        if (highPriority || resource === "Security" || safeAction.includes("ล้มเหลว")) {
            sendSecurityAlert(safeAction, { ip: safeIp, userId, path: safePath, reqId: traceId });
        }
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