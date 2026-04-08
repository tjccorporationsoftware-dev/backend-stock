const { prisma } = require("../../prismaClient");
const logger = require("../../utils/logger");

const SEVERITY_MAP = {
    high: ['delete', 'remove', 'drop', 'revoke', 'deny', 'forbidden', 'failed', 'logout', 'ระงับ', 'ลบ'],
    medium: ['update', 'edit', 'approve', 'transfer', 'adjust', 'patch', 'put', 'แก้ไข', 'อนุมัติ', 'ย้าย']
};

async function listAuditLogs(req, res) {
    try {
        let { page = 1, limit = 30, search, user, action, resource, severity } = req.query;
        const safeLimit = Math.min(parseInt(limit) || 30, 100);
        const skip = (parseInt(page) - 1) * safeLimit;

        let where = { AND: [] };

        if (user && user !== 'all') where.AND.push({ user: { username: user } });
        if (action && action !== 'all') where.AND.push({ action });
        if (resource && resource !== 'all') where.AND.push({ resource });

        if (severity && severity !== 'all') {
            const keywords = SEVERITY_MAP[severity] || [];
            if (severity === 'low') {
                const exclude = [...SEVERITY_MAP.high, ...SEVERITY_MAP.medium];
                where.AND.push({
                    NOT: exclude.map(k => ({ action: { contains: k, mode: 'insensitive' } }))
                });
            } else {
                where.AND.push({
                    OR: keywords.map(k => ({ action: { contains: k, mode: 'insensitive' } }))
                });
            }
        }

        if (search) {
            where.AND.push({
                OR: [
                    { action: { contains: search, mode: 'insensitive' } },
                    { resource: { contains: search, mode: 'insensitive' } },
                    { ip: { contains: search, mode: 'insensitive' } },
                    { user: { username: { contains: search, mode: 'insensitive' } } },
                ]
            });
        }

        const [logs, total] = await Promise.all([
            prisma.auditLog.findMany({
                where,
                orderBy: { createdAt: "desc" },
                take: safeLimit,
                skip: skip,
                include: {
                    user: { select: { username: true, firstName: true, lastName: true } }
                }
            }),
            prisma.auditLog.count({ where })
        ]);

        res.json({
            data: logs,
            total,
            page: parseInt(page),
            totalPages: Math.ceil(total / safeLimit)
        });
    } catch (error) {
        logger.error("[Audit Controller] Error fetching logs", {
            error: error.message,
            ip: req.ip,
            userId: req.user?.id,
            query: req.query
        });
        res.status(500).json({ message: "Error fetching logs" });
    }
}

async function getAuditFilters(req, res) {
    try {
        const [actions, resources, users] = await Promise.all([
            prisma.auditLog.findMany({ select: { action: true }, distinct: ['action'] }),
            prisma.auditLog.findMany({ select: { resource: true }, distinct: ['resource'] }),
            prisma.user.findMany({ select: { username: true, firstName: true, lastName: true } })
        ]);

        res.json({
            actions: actions.map(a => a.action).filter(Boolean).sort(),
            resources: resources.map(r => r.resource).filter(Boolean).sort(),
            users: users.map(u => ({
                username: u.username,
                name: `${u.firstName || ""} ${u.lastName || ""}`.trim() || u.username
            }))
        });
    } catch (error) {
        logger.error("[Audit Controller] Audit Filter Error", {
            error: error.message,
            ip: req.ip,
            userId: req.user?.id
        });
        res.status(500).json({ message: "Internal Server Error" });
    }
}

module.exports = { listAuditLogs, getAuditFilters };