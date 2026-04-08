const { prisma } = require("../../prismaClient");
const { hashPassword } = require("../../utils/password");
const { logActivity } = require("../../utils/auditService");
const logger = require("../../utils/logger"); // 💡 [เพิ่ม] นำเข้า Logger

async function listUsers(req, res) {
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, username: true, firstName: true, lastName: true, isActive: true, // ❌ ไม่มี email
        departmentId: true,
        department: { select: { name: true } },
        roles: { include: { role: true } }
      },
      orderBy: { createdAt: "desc" }
    });
    res.json(users);
  } catch (e) {
    logger.error("[User Controller] List Users Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: `ดึงข้อมูลล้มเหลว: ${e.message}` });
  }
}

async function getUser(req, res) {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "ไม่พบรหัสผู้ใช้งาน (ID)" });

    const user = await prisma.user.findUnique({
      where: { id: id },
      include: { department: true, roles: { include: { role: true } } }
    });

    if (!user) {
      // 💡 [อัปเกรด Security] ดักคนสุ่ม ID เพื่อหวังดูข้อมูล User อื่น
      const safeId = String(id).replace(/[\r\n]/g, "");
      logger.warn(`[User Controller] พยายามเรียกดูข้อมูล User ที่ไม่มีอยู่จริง (ID: ${safeId})`, { ip: req.ip, userId: req.user?.id });
      return res.status(404).json({ message: "ไม่พบข้อมูลพนักงาน" });
    }

    res.json(user);
  } catch (e) {
    logger.error("[User Controller] Get User Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: `ดึงข้อมูลผิดพลาด: ${e.message}` });
  }
}

async function createUser(req, res) {
  try {
    const { username, firstName, lastName, password, departmentId } = req.body;

    // 💡 [แก้ไข] แปลงค่า departmentId ให้เป็น null ถ้าได้รับมาเป็นค่าว่าง
    const validDeptId = departmentId ? departmentId : null;

    const user = await prisma.user.create({
      data: {
        username,
        firstName,
        lastName,
        passwordHash: await hashPassword(password),
        departmentId: validDeptId
      }
    });

    try { logActivity(req, `สร้างบัญชี: ${username}`, "User", user.id, false); } catch (err) { }
    res.status(201).json(user);
  } catch (e) {
    if (e.code === 'P2002') return res.status(409).json({ message: "Username นี้มีผู้ใช้งานแล้ว" });
    logger.error("[User Controller] Create User Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: `สร้างบัญชีล้มเหลว: ${e.message}` });
  }
}

async function updateUser(req, res) {
  try {
    // ✅ แก้บั๊ก Cannot destructure property 'id'
    const id = req.params?.id;
    if (!id) return res.status(400).json({ message: "ไม่พบรหัสพนักงานที่ต้องการแก้ไข" });

    const { firstName, lastName, isActive, password, departmentId } = req.body;

    const updateData = {};
    if (firstName !== undefined) updateData.firstName = firstName;
    if (lastName !== undefined) updateData.lastName = lastName;
    if (isActive !== undefined) updateData.isActive = isActive;

    // 💡 [แก้ไข] รับค่าแผนกให้ถูกต้อง ถ้าว่างให้เป็น null (แก้บั๊ก 400 Bad Request)
    if (departmentId !== undefined) {
      updateData.departmentId = departmentId ? departmentId : null;
    }

    // 💡 [แก้ไข] อัปเดตรหัสผ่านเฉพาะตอนที่กรอกมาเท่านั้น
    if (password && password.trim() !== "") {
      updateData.passwordHash = await hashPassword(password);
    }

    const user = await prisma.user.update({ where: { id }, data: updateData });

    // 💡 ถ้ามีการแก้รหัสผ่าน หรือสั่งแบน (isActive = false) ให้ถือเป็น Log สำคัญ
    const isCriticalUpdate = (password && password.trim() !== "") || isActive === false;
    try { logActivity(req, `อัปเดตบัญชี: ${user.username}`, "User", id, isCriticalUpdate); } catch (err) { }

    res.json(user);
  } catch (e) {
    logger.error("[User Controller] Update User Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: `อัปเดตล้มเหลว: ${e.message}` });
  }
}

async function deleteUser(req, res) {
  try {
    const id = req.params?.id;
    if (req.user?.id === id) {
      // 💡 [อัปเกรด Security] ดักจับความพยายามลบตัวเอง
      logActivity(req, `พยายามลบบัญชีตนเอง (Logic Flaw Attempt) ID: ${id}`, "Security", id, true);
      return res.status(400).json({ message: "ไม่อนุญาตให้ลบบัญชีตนเอง" });
    }

    await prisma.user.delete({ where: { id } });

    // 💡 [อัปเกรด Security] ลบบัญชีผู้ใช้เป็นเรื่องใหญ่ ต้องยิงเตือนเข้า LINE ทันที
    logActivity(req, `ลบบัญชีผู้ใช้งาน ID: ${id}`, "Security", id, true);

    res.status(204).send();
  } catch (e) {
    logger.error("[User Controller] Delete User Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: `ลบไม่สำเร็จ: ข้อมูลอาจถูกใช้งานอยู่` });
  }
}

async function setRoles(req, res) {
  try {
    const id = req.params?.id;
    const { roles } = req.body;
    const roleRows = await prisma.role.findMany({ where: { name: { in: roles } } });
    await prisma.$transaction([
      prisma.userRole.deleteMany({ where: { userId: id } }),
      prisma.userRole.createMany({ data: roleRows.map(r => ({ userId: id, roleId: r.id })) })
    ]);

    // 💡 [อัปเกรด Security] ดักจับการแก้ไข Role (Privilege Escalation) ยิงเตือนทันที!
    logActivity(req, `เปลี่ยนแปลงสิทธิ์ (Roles) ของบัญชี ID: ${id} เป็น [${roles.join(', ')}]`, "Security", id, true);

    res.json({ success: true });
  } catch (e) {
    logger.error("[User Controller] Set Roles Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: `อัปเดต Role ล้มเหลว: ${e.message}` });
  }
}

async function listRoles(req, res) {
  try {
    const roles = await prisma.role.findMany({ orderBy: { name: 'asc' } });
    res.json(roles);
  } catch (e) {
    logger.error("[User Controller] List Roles Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: e.message });
  }
}

async function getRolePermissions(req, res) {
  try {
    const perms = await prisma.rolePermission.findMany({ where: { roleId: req.params.roleId }, include: { permission: true } });
    res.json(perms.map(rp => rp.permission.code));
  } catch (e) {
    logger.error("[User Controller] Get Role Perms Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: e.message });
  }
}

async function updateRolePermissions(req, res) {
  try {
    const { roleId } = req.params;
    const { permissions } = req.body;
    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      const permsInDb = await tx.permission.findMany({ where: { code: { in: permissions } } });
      await tx.rolePermission.createMany({ data: permsInDb.map(p => ({ roleId, permissionId: p.id })) });
    });

    // 💡 [อัปเกรด Security] ดักจับการปรับแต่งระบบสิทธิ์ ยิงเตือนทันที!
    logActivity(req, `เปลี่ยนแปลง Permissions ระดับโครงสร้าง ของ Role ID: ${roleId}`, "Security", roleId, true);

    res.json({ success: true });
  } catch (e) {
    logger.error("[User Controller] Update Role Perms Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: `อัปเดตสิทธิ์ล้มเหลว: ${e.message}` });
  }
}

module.exports = {
  listUsers, getUser, createUser, updateUser, deleteUser, setRoles,
  listRoles, getRolePermissions, updateRolePermissions
};