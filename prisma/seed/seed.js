require("dotenv").config();
const { prisma } = require("../../src/prismaClient");
const { hashPassword } = require("../../src/utils/password");

async function main() {
  const adminPass = process.env.INITIAL_ADMIN_PASSWORD;
  const adminEmail = process.env.INITIAL_ADMIN_EMAIL || "admin@tjc.local";
  const adminUsername = process.env.INITIAL_ADMIN_USERNAME || "admin";

  if (!adminPass) {
    throw new Error("❌ ความปลอดภัยล้มเหลว: ไม่พบ INITIAL_ADMIN_PASSWORD ในไฟล์ .env");
  }

  // --- ส่วนจัดการ Permissions ---
  const perms = [
    "user.read", "user.create", "user.update", "user.disable", "user.assignRole", "user.delete",
    "role.read", "role.manage", "audit.read", "system.admin", "master.read", "master.manage",
    "product.read", "product.manage", "warehouse.read", "warehouse.manage",
    "INBOUND_CREATE", "TRANSFER_CREATE", "OUTBOUND_CREATE", "INVENTORY_VIEW", "REPORT_EXPORT",
  ];

  console.log("🛡️ กำลังเตรียมระบบ Permissions...");
  for (const code of perms) {
    await prisma.permission.upsert({
      where: { code },
      update: {},
      create: { code },
    });
  }

  const adminRole = await prisma.role.upsert({ where: { name: "Admin" }, update: {}, create: { name: "Admin" } });
  const managerRole = await prisma.role.upsert({ where: { name: "Manager" }, update: {}, create: { name: "Manager" } });
  const staffRole = await prisma.role.upsert({ where: { name: "Staff" }, update: {}, create: { name: "Staff" } });

  const allPerms = await prisma.permission.findMany();

  // Admin -> All Perms (ใช้ Transaction เพื่อความชัวร์)
  await prisma.$transaction(
    allPerms.map(p => prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: adminRole.id, permissionId: p.id } },
      update: {},
      create: { roleId: adminRole.id, permissionId: p.id },
    }))
  );

  const adminUser = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      username: adminUsername,
      firstName: "System",
      lastName: "Administrator",
      passwordHash: await hashPassword(adminPass),
      isActive: true
    },
  });

  await prisma.userRole.upsert({
    where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
    update: {},
    create: { userId: adminUser.id, roleId: adminRole.id },
  });

  console.log("✅ การติดตั้งข้อมูลเริ่มต้นสำเร็จ");
  console.log(`👤 ผู้ดูแลระบบ: ${adminUsername} (${adminEmail})`);
}

main()
  .catch((e) => {
    console.error("❌ เกิดข้อผิดพลาดร้ายแรง:", e.message);
    process.exit(1);
  })
  .finally(async () => { await prisma.$disconnect(); });