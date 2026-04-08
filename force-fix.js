const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function forceFix() {
    const targetUsername = 'admin';

    console.log('🔍 [System Security] กำลังเริ่มกระบวนการตรวจสอบและอัปเดตสิทธิ์...');

    const permissionCodes = [
        'INBOUND_READ', 'INBOUND_CREATE',
        'OUTBOUND_READ', 'OUTBOUND_CREATE',
        'INVENTORY_VIEW',      // 🔑 สำหรับดูยอดบาลานซ์
        'INVENTORY_TRANSFER',  // 🔑 สำหรับโอนย้าย
        'INVENTORY_ADJUST',    // 💡 🔑 กุญแจดอกใหม่! สำหรับหน้าปรับปรุงยอด (ต้องมีคำนี้)
        'MASTER_DATA_READ',    // 🔑 สำหรับดึง Dropdown คลังและสินค้า
        'AUDIT_LOG_VIEW',
        'MASTER_DATA_CREATE',    // 🔑 สำหรับดึง Dropdown คลังและสินค้า
        'PURCHASE_CREATE',
        "PR_READ",
        "PR_CREATE",     // 🔑 สำหรับสร้างใบสั่งซื้อ (PO),
        "PR_APPROVE", // สำหรับให้ Manager กดอนุมัติ
        "REQUISITION_CREATE",  // 🔑 สำหรับให้พนักงานกด "สร้างใบเบิก"
        "REQUISITION_APPROVE",// 🔑 สำหรับให้หัวหน้ากด "อนุมัติ/ปฏิเสธ" ใบเบิก
        "INVENTORY_READ",
        "MASTER_EDITx" ,
        "ADMIN"

    ];

    // สร้างหรืออัปเดต Permission ในฐานข้อมูล
    const perms = [];
    for (const code of permissionCodes) {
        const p = await prisma.permission.upsert({
            where: { code },
            update: {},
            create: { code }
        });
        perms.push(p);
        console.log(`✅ Verified Permission: ${code}`);
    }

    // 2. ตรวจสอบ User
    const user = await prisma.user.findUnique({
        where: { username: targetUsername },
        include: { roles: { include: { role: true } } }
    });

    if (!user) {
        console.error(`❌ CRITICAL ERROR: ไม่พบ User '${targetUsername}' ในระบบ`);
        return;
    }

    // 3. จัดการ Role และผูก Permission (หลักการ Least Privilege)
    // สำหรับ Admin เราจะให้กุญแจทุกดอก แต่ในงานวิจัยคุณสามารถแยก Role อื่นได้ภายหลัง
    let adminRoleId;
    if (user.roles.length === 0) {
        const adminRole = await prisma.role.upsert({
            where: { name: 'Admin' },
            update: {},
            create: { name: 'Admin' }
        });
        adminRoleId = adminRole.id;

        await prisma.userRole.upsert({
            where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
            update: {},
            create: { userId: user.id, roleId: adminRole.id }
        });
    } else {
        adminRoleId = user.roles[0].roleId; // ใช้ Role แรกที่มี
    }

    // ผูกกุญแจสิทธิ์ทั้งหมดเข้ากับ Role
    for (const p of perms) {
        await prisma.rolePermission.upsert({
            where: { roleId_permissionId: { roleId: adminRoleId, permissionId: p.id } },
            update: {},
            create: { roleId: adminRoleId, permissionId: p.id }
        });
    }

    console.log(`✨ [Security Update] อัปเดตสิทธิ์ ${permissionCodes.length} รายการให้ Role เรียบร้อยแล้ว`);
    console.log('👉 คำแนะนำ: กรุณา Logout และ Login ใหม่เพื่ออัปเดต Token ชุดใหม่ครับ');
}

forceFix()
    .catch(e => console.error('❌ Error during security update:', e))
    .finally(() => prisma.$disconnect());