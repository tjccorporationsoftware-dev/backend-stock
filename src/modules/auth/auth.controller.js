const { prisma } = require("../../prismaClient");
const { verifyPassword, hashPassword } = require("../../utils/password");
const { signAccessToken, newRefreshTokenPlain, hashRefreshToken } = require("../../utils/tokens");
const { logActivity } = require("../../utils/auditService");

const cookieOpts = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/auth/refresh",
};

const DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=4$R1BIVW9VblhKbkRWVVRxcg$V5f39rP2V/8uG2uA2rT5eN0m52Lz1D2YQvXq1v1d4kM";

async function login(req, res) {
  try {
    const { username, password } = req.body;

    const user = await prisma.user.findUnique({
      where: { username: username },
      include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
    });

    if (!user || !user.isActive) {
      await verifyPassword(DUMMY_HASH, password).catch(() => null);
      // 💡 [เพิ่ม true] แจ้งเตือนคนเดา Username มั่ว
      logActivity(req, `เข้าสู่ระบบล้มเหลว (ไม่พบผู้ใช้งานหรือบัญชีถูกระงับ): ${username}`, "Security", null, true);
      return res.status(401).json({ message: "ข้อมูลไม่ถูกต้อง หรือบัญชีถูกระงับ" });
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      // 💡 [เพิ่ม true] แจ้งเตือนพยายามเข้าบัญชีที่ถูกแบน
      logActivity(req, `พยายามเข้าสู่ระบบบัญชีที่ถูกล็อคชั่วคราว: ${username}`, "Security", user.id, true);
      return res.status(403).json({ message: "บัญชีถูกระงับชั่วคราวจากการเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาที" });
    }

    const ok = await verifyPassword(user.passwordHash, password);

    if (!ok) {
      const attempts = (user.failedLoginAttempts || 0) + 1;
      const updateData = { failedLoginAttempts: attempts };

      if (attempts >= 5) {
        updateData.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        // 💡 [เพิ่ม true] แจ้งเตือนบัญชีโดนระงับ
        logActivity(req, `บัญชีถูกล็อคชั่วคราว (เข้าสู่ระบบผิด 5 ครั้ง): ${username}`, "Security", user.id, true);
      } else {
        // 💡 [เพิ่ม true] แจ้งเตือนรหัสผิด
        logActivity(req, `เข้าสู่ระบบล้มเหลว (รหัสผ่านผิดครั้งที่ ${attempts}): ${username}`, "Security", user.id, true);
      }

      await prisma.user.update({ where: { id: user.id }, data: updateData });
      return res.status(401).json({ message: "ข้อมูลไม่ถูกต้อง หรือบัญชีถูกระงับ" });
    }

    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await prisma.user.update({
        where: { id: user.id },
        data: { failedLoginAttempts: 0, lockedUntil: null }
      });
    }

    const perms = Array.from(new Set(user.roles.flatMap(r => r.role.permissions.map(rp => rp.permission.code))));
    const accessToken = signAccessToken(user.id, perms);
    const refreshPlain = newRefreshTokenPlain();

    await prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshPlain),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    res.cookie("refresh_token", refreshPlain, { ...cookieOpts, maxAge: 30 * 24 * 60 * 60 * 1000 });
    req.user = { id: user.id };

    // 💡 [ล็อกอินสำเร็จ] ไม่ต้องส่ง LINE (false) เก็บแค่ Database พอ
    logActivity(req, "เข้าสู่ระบบสำเร็จ", "Auth", user.id, false);

    return res.json({ accessToken });
  } catch (error) {
    console.error("[Login Error]:", error);
    return res.status(500).json({ message: "เกิดข้อผิดพลาดภายในระบบ" });
  }
}

async function refresh(req, res) {
  try {
    const refreshPlain = req.cookies?.refresh_token;
    if (!refreshPlain) return res.status(401).json({ message: "No refresh token" });
    const refreshHash = hashRefreshToken(refreshPlain);
    const tokenRow = await prisma.refreshToken.findFirst({
      where: { tokenHash: refreshHash },
      include: {
        user: {
          include: {
            roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } },
          },
        },
      },
    });

    if (!tokenRow) {
      return res.status(401).json({ message: "Invalid refresh token" });
    }

    // 💡 [จุดอันตราย] กรณีมีคนแอบโขมย Refresh Token ไปใช้
    if (tokenRow.revokedAt !== null) {
      console.warn(`[SECURITY ALERT] Refresh token reuse detected for user ${tokenRow.userId}`);
      // 💡 [เพิ่มบรรทัดนี้] ยิงเตือนเข้า LINE ทันทีเมื่อเกิด Token Reuse
      logActivity(req, `[ALERT] ตรวจพบการนำ Refresh Token ที่ถูกเพิกถอนไปแล้วมาใช้ซ้ำ!`, "Security", tokenRow.userId, true);

      await prisma.refreshToken.updateMany({
        where: { userId: tokenRow.userId },
        data: { revokedAt: new Date() }
      });
      return res.status(401).json({ message: "ตรวจพบความผิดปกติ กรุณาเข้าสู่ระบบใหม่อีกครั้ง" });
    }

    if (tokenRow.expiresAt < new Date() || !tokenRow.user.isActive) {
      return res.status(401).json({ message: "Token expired or user inactive" });
    }
    await prisma.refreshToken.update({ where: { id: tokenRow.id }, data: { revokedAt: new Date() } });

    const perms = Array.from(new Set(
      tokenRow.user.roles.flatMap(r => r.role.permissions.map(rp => rp.permission.code))
    ));

    const accessToken = signAccessToken(tokenRow.userId, perms);
    const newPlain = newRefreshTokenPlain();

    await prisma.refreshToken.create({
      data: {
        userId: tokenRow.userId,
        tokenHash: hashRefreshToken(newPlain),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    res.cookie("refresh_token", newPlain, { ...cookieOpts, maxAge: 30 * 24 * 60 * 60 * 1000 });
    return res.json({ accessToken });
  } catch (error) {
    console.error("[Refresh Error]:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function logout(req, res) {
  try {
    const refreshPlain = req.cookies?.refresh_token;
    if (refreshPlain) {
      await prisma.refreshToken.updateMany({
        where: { tokenHash: hashRefreshToken(refreshPlain), revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    res.clearCookie("refresh_token", cookieOpts);
    if (req.user && req.user.id) {
      logActivity(req, "ออกจากระบบ", "Auth", req.user.id, false);
    }

    return res.json({ ok: true });
  } catch (error) {
    res.clearCookie("refresh_token", cookieOpts);
    return res.status(500).json({ message: "Internal server error" });
  }
}

async function me(req, res) {
  return res.json({ userId: req.user.id, perms: req.user.perms });
}

module.exports = { login, refresh, logout, me };