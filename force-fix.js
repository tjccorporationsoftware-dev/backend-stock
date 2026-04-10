const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function forceFix() {
    const targetUsername = 'admin'; // เปลี่ยนเป็น Username ของคุณ

    console.log('🚀 [System Security] กำลังปรับปรุงกลุ่มผู้ใช้งานและสิทธิ์ทั้งระบบ...');

    // 1. รายชื่อสิทธิ์ทั้งหมด 23 รายการ
    const allPermissions = [
        'SYSTEM_SETTINGS_MANAGE', 'USER_MANAGE', 'AUDIT_LOG_VIEW',
        'MASTER_DATA_READ', 'MASTER_DATA_MANAGE', 'WAREHOUSE_MANAGE',
        'PR_READ', 'PR_CREATE', 'PR_APPROVE', 'PO_MANAGE',
        'INBOUND_READ', 'INBOUND_CREATE', 'OUTBOUND_READ', 'OUTBOUND_CREATE',
        'REQUISITION_READ', 'REQUISITION_CREATE', 'REQUISITION_APPROVE',
        'INVENTORY_READ', 'TRANSFER_MANAGE', 'ADJUSTMENT_MANAGE', 'COUNT_TASK_MANAGE',
        'DASHBOARD_VIEW', 'REPORT_EXPORT'
    ];

    // สร้างสิทธิ์ทั้งหมดลง DB
    const permObjects = [];
    for (const code of allPermissions) {
        const p = await prisma.permission.upsert({
            where: { code }, update: {}, create: { code }
        });
        permObjects.push(p);
    }

    // 2. นิยามกลุ่มผู้ใช้ (Roles) และ สิทธิ์ที่ควรได้รับ (Default Mapping)
    const rolesConfig = [
        { name: 'Admin', perms: allPermissions }, // ได้ทุกอย่าง
        { 
            name: 'Executive', 
            perms: ['DASHBOARD_VIEW', 'REPORT_EXPORT', 'PR_APPROVE', 'REQUISITION_APPROVE', 'INVENTORY_READ', 'AUDIT_LOG_VIEW'] 
        },
        { 
            name: 'Purchasing', 
            perms: ['PR_READ', 'PR_CREATE', 'PO_MANAGE', 'MASTER_DATA_READ', 'MASTER_DATA_MANAGE', 'INBOUND_READ'] 
        },
        { 
            name: 'Warehouse', 
            perms: ['INBOUND_READ', 'INBOUND_CREATE', 'OUTBOUND_READ', 'OUTBOUND_CREATE', 'INVENTORY_READ', 'TRANSFER_MANAGE', 'ADJUSTMENT_MANAGE', 'COUNT_TASK_MANAGE', 'WAREHOUSE_MANAGE'] 
        },
        { 
            name: 'Staff', 
            perms: ['REQUISITION_READ', 'REQUISITION_CREATE', 'PR_READ', 'PR_CREATE', 'INVENTORY_READ'] 
        }
    ];

    // 3. เริ่มกระบวนการสร้าง Role และผูก Permission
    for (const roleCfg of rolesConfig) {
        // สร้าง Role
        const role = await prisma.role.upsert({
            where: { name: roleCfg.name },
            update: {},
            create: { name: roleCfg.name }
        });

        // ล้างสิทธิ์เก่าของ Role นี้ออกก่อน เพื่อป้องกันสิทธิ์ซ้ำซ้อน
        await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });

        // ผูกสิทธิ์ใหม่ตาม Config
        const rolePermData = permObjects
            .filter(p => roleCfg.perms.includes(p.code))
            .map(p => ({ roleId: role.id, permissionId: p.id }));

        await prisma.rolePermission.createMany({ data: rolePermData });
        console.log(`✅ Role [${roleCfg.name}]: อัปเดต ${rolePermData.length} สิทธิ์เรียบร้อย`);
    }

    // 4. บังคับให้ User ของเราเป็น Admin (เพื่อไม่ให้หลุดสิทธิ์การจัดการ)
    const user = await prisma.user.findUnique({ where: { username: targetUsername } });
    if (user) {
        const adminRole = await prisma.role.findFirst({ where: { name: 'Admin' } });
        await prisma.userRole.upsert({
            where: { userId_roleId: { userId: user.id, roleId: adminRole.id } },
            update: {},
            create: { userId: user.id, roleId: adminRole.id }
        });
        console.log(`✨ บังคับ User @${targetUsername} เป็น Admin เรียบร้อย`);
    }

    console.log('\n🌟 ทุกอย่างเรียบร้อย! กรุณารีเฟรชหน้าเว็บ หรือ Login ใหม่ครับ');
}

forceFix()
    .catch(e => console.error('❌ Error:', e))
    .finally(async () => await prisma.$disconnect());