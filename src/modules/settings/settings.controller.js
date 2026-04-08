const { prisma } = require('../../prismaClient');
const { logActivity } = require('../../utils/auditService'); // 💡 [เพิ่ม] นำเข้า Audit Service
const logger = require('../../utils/logger'); // 💡 [เพิ่ม] นำเข้า Logger

// 💡 ดึงข้อมูลการตั้งค่าบริษัท
const getCompanySettings = async (req, res) => {
    try {
        // ใช้ upsert เพื่อให้มั่นใจว่าจะมีข้อมูลแถว 'main-config' เสมอ
        // ถ้าไม่มีระบบจะสร้างให้เป็นค่าว่างตาม Schema ทันที
        const settings = await prisma.companySettings.upsert({
            where: { id: "main-config" },
            update: {},
            create: { id: "main-config" }
        });
        res.json(settings);
    } catch (error) {
        // 💡 [อัปเกรด] บันทึก Error ลงไฟล์ ไม่หลุดไปหน้าบ้าน
        logger.error("[Settings] Get Company Settings Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: "ไม่สามารถดึงข้อมูลการตั้งค่าได้" });
    }
};

// 💡 บันทึกหรืออัปเดตข้อมูลบริษัท
const updateCompanySettings = async (req, res) => {
    try {
        const { id, updatedAt, ...updateData } = req.body; // แยก id และวันที่ออกไม่ให้ส่งไปอัปเดตซ้ำ

        const updated = await prisma.companySettings.update({
            where: { id: "main-config" },
            data: updateData
        });

        // 💡 [อัปเกรด Security] บันทึก Log ว่ามีคนเข้ามาแก้ไขข้อมูลระบบหลัก
        logActivity(req, `แก้ไขข้อมูลการตั้งค่าบริษัท (Company Profile)`, "Settings", "main-config", false);

        res.json({ success: true, data: updated });
    } catch (error) {
        // 💡 [อัปเกรด] บันทึก Error ลงไฟล์
        logger.error("[Settings] Update Company Settings Error", { error: error.message, ip: req.ip, userId: req.user?.id });
        res.status(500).json({ message: "เกิดข้อผิดพลาดในการบันทึกข้อมูล" });
    }
};

module.exports = {
    getCompanySettings,
    updateCompanySettings
};