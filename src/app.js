require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const hpp = require("hpp");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const path = require("path");

const { requestIdMiddleware } = require("./utils/requestId");
const { errorHandler } = require("./middlewares/errorHandler");

const { authRoutes } = require("./modules/auth/auth.routes");
const { userRoutes } = require("./modules/users/users.routes");
const { auditRoutes } = require("./modules/audit/audit.routes");
const { masterRoutes } = require("./modules/master/master.routes");
const { inboundRoutes } = require("./modules/inbound/inbound.routes");
const { transferRoutes } = require("./modules/transfer/transfer.routes");
const { outboundRoutes } = require("./modules/outbound/outbound.routes");
const { inventoryRoutes } = require("./modules/inventory/inventory.routes");
const { reportsRoutes } = require("./modules/reports/reports.routes");
const { purchaseRoutes } = require('./modules/purchase/purchase.routes');
const { settingsRoutes } = require('./modules/settings/settings.routes');
const { countTaskRoutes } = require("./modules/inventory/countTask.routes");

const app = express();

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(requestIdMiddleware());

app.use(helmet({
  hsts: process.env.NODE_ENV === "production"
    ? { maxAge: 31536000, includeSubDomains: true, preload: true }
    : false,
  // 💡 สำคัญ: อนุญาตให้รูปภาพโหลดข้าม Domain ได้ (ป้องกันรูปไม่ขึ้นใน Chrome/Edge)
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

app.use(hpp());
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

// 💡 [เพิ่มบรรทัดนี้] เปิดทางให้เข้าถึงไฟล์รูปภาพในโฟลเดอร์ public/uploads 
// เช่น http://localhost:4000/uploads/avatars/image.jpg
app.use("/uploads", express.static(path.join(process.cwd(), "public/uploads")));

const allowlist = (process.env.CORS_ALLOWLIST || "").split(",").filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (allowlist.includes("*") || !origin || allowlist.includes(origin)) {
      return cb(null, true);
    }
    return cb(new Error("CORS blocked"), false);
  },
  credentials: true,
}));

app.use(rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: "ระบบตรวจพบการส่งข้อมูลที่ผิดปกติ กรุณารอ 5 นาทีแล้วลองใหม่"
  }
}));

app.use((req, res, next) => {
  const proto = req.headers["x-forwarded-proto"];
  if (process.env.NODE_ENV === "production" && proto && proto !== "https") {
    return res.status(403).json({ message: "HTTPS required" });
  }
  next();
});

app.get("/health", (req, res) => res.json({ ok: true, message: "System is healthy" }));

app.use("/auth", authRoutes);
app.use("/users", userRoutes);
app.use("/audit", auditRoutes);
app.use("/master", masterRoutes);
app.use('/inbound', inboundRoutes);
app.use('/api/transfer', transferRoutes);
app.use('/outbound', outboundRoutes);
app.use('/inventory', inventoryRoutes);
app.use("/inventory/count-tasks", countTaskRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/purchase', purchaseRoutes);
app.use('/api/settings', settingsRoutes);

app.use(errorHandler);

module.exports = { app };