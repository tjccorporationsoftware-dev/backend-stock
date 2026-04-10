const { logActivity } = require("../utils/auditService");

function requirePermissions(required, options = {}) {
    const mode = options.mode || "all"; // all | any

    return (req, res, next) => {
        const perms = req.user?.perms || [];

        const ok =
            mode === "any"
                ? required.some(p => perms.includes(p))
                : required.every(p => perms.includes(p));

        if (!ok) {
            const userId = req.user?.id || "Unknown";
            console.warn(`[Security Alert] User ID: ${userId} attempted to access restricted route.`);
            logActivity(
                req,
                `พยายามเข้าถึงข้อมูลที่ไม่มีสิทธิ์ (mode=${mode}, ต้องการ: ${required.join(",")})`,
                "Security",
                userId
            );
            return res.status(403).json({
                message: "คุณไม่มีสิทธิ์เข้าถึงข้อมูลหรือทำรายการในส่วนนี้"
            });
        }

        next();
    };
}

module.exports = { requirePermissions };