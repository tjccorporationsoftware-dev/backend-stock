const { prisma } = require("../prismaClient");

function auditLogger() {
  return (req, res, next) => {
    const start = Date.now();

    res.on("finish", async () => {
      // บันทึกเฉพาะการเขียนข้อมูล (Write) หรือการ Export
      const isWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method);
      const isExport = req.originalUrl.includes("export");
      const isAuth = req.originalUrl.includes("/auth");

      if (!isWrite && !isExport && !isAuth) return;

      try {
        // 💡 สร้างประโยคกิจกรรม: เช่น "ลบสินค้า: SKU-001" หรือ "ส่งออกรายงานสต็อก"
        const actionDetail = req.auditAction || `${req.method} ${req.originalUrl}`;
        const targetName = req.auditTarget ? `: ${req.auditTarget}` : "";

        await prisma.auditLog.create({
          data: {
            userId: req.user?.id || null,
            action: `${actionDetail}${targetName}`, // ผลลัพธ์: "ลบสินค้า: Notebook MSI"
            resource: req.baseUrl.replace("/", "") || "system",
            resourceId: req.params.id || null,
            method: req.method,
            path: req.originalUrl,
            statusCode: res.statusCode,
            ip: req.ip || "unknown",
            userAgent: req.headers["user-agent"],
            meta: {
              duration: `${Date.now() - start}ms`,
              payload: req.method !== "GET" ? maskSensitive(req.body) : null
            }
          }
        });
      } catch (err) { /* ป้องกันแอปพังจาก Log Error */ }
    });
    next();
  };
}

// 🛡️ ฟังก์ชันช่วย Mask ข้อมูลลับ
function maskSensitive(body) {
  const data = { ...body };
  if (data.password) data.password = "********";
  return data;
}

module.exports = { auditLogger };