const { prisma } = require("../../prismaClient");
const { logActivity } = require("../../utils/auditService");
const logger = require("../../utils/logger"); // 💡 [เพิ่ม] นำเข้า Logger
let bwipjs;

// 💡 [อัปเกรด] ให้ฟังก์ชันรับ req เข้ามาด้วยเพื่อจด IP และ User ที่ทำ Error
function handlePrismaError(e, res, req = null) {
  if (e.code === 'P2002') return res.status(409).json({ message: "ข้อมูลนี้มีอยู่ในระบบแล้ว (ข้อมูลซ้ำ)" });
  if (e.code === 'P2003') return res.status(400).json({ message: "ไม่สามารถดำเนินการได้ เนื่องจากข้อมูลถูกอ้างอิงหรือใช้งานอยู่" });
  if (e.code === 'P2025') return res.status(404).json({ message: "ไม่พบข้อมูลที่ต้องการในระบบ" });

  // 💡 [เพิ่ม] บันทึก Database Error ขั้นรุนแรงลงไฟล์ Log
  logger.error("[Master Data Error]", { error: e.message, code: e.code, ip: req?.ip, userId: req?.user?.id });
  return res.status(500).json({ message: "เกิดข้อผิดพลาดภายในเซิร์ฟเวอร์" });
}

async function listCategories(req, res) {
  const rows = await prisma.category.findMany({ orderBy: { name: "asc" } });
  res.json(rows);
}

async function createCategory(req, res) {
  try {
    const { name, abbr } = req.body;
    const row = await prisma.category.create({
      data: { name, abbr }
    });

    logActivity(req, `เพิ่มหมวดหมู่: ${row.name} (ตัวย่อ: ${row.abbr || '-'})`, "MasterData", row.id);
    res.status(201).json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function updateCategory(req, res) {
  try {
    const { id } = req.params;
    const { name, abbr } = req.body;

    const row = await prisma.category.update({
      where: { id },
      data: { name, abbr }
    });

    logActivity(req, `แก้ไขหมวดหมู่: ${row.name} (ตัวย่อ: ${row.abbr || '-'})`, "MasterData", row.id);
    res.json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function deleteCategory(req, res) {
  try {
    const category = await prisma.category.findUnique({ where: { id: req.params.id } });
    await prisma.category.delete({ where: { id: req.params.id } });

    if (category) {
      // 💡 [อัปเกรด Security] การลบ Master Data เป็นเรื่องใหญ่ ให้ยิงแจ้งเตือน (true)
      logActivity(req, `ลบหมวดหมู่: ${category.name}`, "MasterData", category.id, true);
    }
    res.status(204).send();
  } catch (e) { handlePrismaError(e, res, req); }
}

async function listUnits(req, res) {
  const rows = await prisma.unit.findMany({ orderBy: { name: "asc" } });
  res.json(rows);
}

async function createUnit(req, res) {
  try {
    const row = await prisma.unit.create({ data: { name: req.body.name } });
    logActivity(req, `เพิ่มหน่วยนับ: ${row.name}`, "MasterData", row.id);

    res.status(201).json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function updateUnit(req, res) {
  try {
    const row = await prisma.unit.update({
      where: { id: req.params.id },
      data: { name: req.body.name }
    });
    logActivity(req, `แก้ไขหน่วยนับ: ${row.name}`, "MasterData", row.id);

    res.json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function deleteUnit(req, res) {
  try {
    const unit = await prisma.unit.findUnique({ where: { id: req.params.id } });
    await prisma.unit.delete({ where: { id: req.params.id } });

    if (unit) {
      // 💡 [อัปเกรด Security] ยิงแจ้งเตือนการลบ
      logActivity(req, `ลบหน่วยนับ: ${unit.name}`, "MasterData", unit.id, true);
    }

    res.status(204).send();
  } catch (e) { handlePrismaError(e, res, req); }
}

async function listProducts(req, res) {
  const rows = await prisma.product.findMany({
    include: { category: true, unit: true, warehouse: true, zone: true, location: true },
    orderBy: { createdAt: "desc" },
  });

  res.json(rows);
}

async function createProduct(req, res) {
  try {
    const { name, categoryId, unitId, warehouseId, zoneId, locationId } = req.body;
    const cat = await prisma.category.findUnique({ where: { id: categoryId } });
    const wh = warehouseId ? await prisma.warehouse.findUnique({ where: { id: warehouseId } }) : null;

    const catAbbr = cat?.abbr || "GEN";
    const whCode = wh?.code || "WH";
    const prefix = `${catAbbr}-${whCode}-`;

    const lastProduct = await prisma.product.findFirst({
      where: { sku: { startsWith: prefix } },
      orderBy: { sku: 'desc' },
      select: { sku: true }
    });

    let nextNumber = 1;
    if (lastProduct?.sku) {
      const parts = lastProduct.sku.split('-');
      const lastPart = parts[parts.length - 1];
      const parsedNum = parseInt(lastPart, 10);
      if (!isNaN(parsedNum)) nextNumber = parsedNum + 1;
    }

    const finalSku = `${prefix}${String(nextNumber).padStart(4, '0')}`;

    const row = await prisma.product.create({
      data: {
        sku: finalSku,
        name, categoryId, unitId, warehouseId, zoneId, locationId,
        barcodeValue: finalSku,
        barcodeType: "code128"
      },
      include: { category: true, unit: true }
    });

    logActivity(req, `สร้างสินค้าใหม่ (Auto-Gen): ${row.sku}`, "Product", row.id);
    res.status(201).json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function updateProduct(req, res) {
  try {
    const { id } = req.params;
    const oldData = await prisma.product.findUnique({ where: { id } });

    const row = await prisma.product.update({
      where: { id },
      data: req.body,
      include: { category: true, unit: true },
    });
    const detail = oldData ? ` (เปลี่ยนจาก: ${oldData.name})` : "";
    logActivity(req, `แก้ไขรายการสินค้า: ${row.sku} -> ${row.name}${detail}`, "Product", row.id);

    res.json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function deleteProduct(req, res) {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    await prisma.product.delete({ where: { id: req.params.id } });
    if (product) {
      // 💡 [อัปเกรด Security] ลบสินค้าถือเป็นเรื่องซีเรียส แจ้งเตือน!
      logActivity(req, `ลบรายการสินค้าออกจากระบบ: ${product.sku} (${product.name})`, "Product", product.id, true);
    }

    res.status(204).send();
  } catch (e) { handlePrismaError(e, res, req); }
}

async function getProductBarcodePng(req, res) {
  try {
    const p = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!p) {
      // 💡 [อัปเกรด Security] ดักคนสุ่ม ID หวังดูข้อมูล
      const safeId = req.params.id.replace(/[\r\n]/g, '');
      logger.warn(`[Master] พยายามดึงข้อมูลที่ไม่มีอยู่จริง (ID: ${safeId})`, { ip: req.ip, userId: req.user?.id });
      return res.status(404).json({ message: "ไม่พบข้อมูลสินค้า" });
    }
    const value = p.barcodeValue || p.sku;
    const type = (p.barcodeType || "code128").toLowerCase();

    const allowedTypes = ['code128', 'code39', 'ean13', 'ean8', 'upca', 'qrcode'];
    if (!allowedTypes.includes(type)) {
      return res.status(400).json({ message: "รูปแบบบาร์โค้ดนี้ไม่ได้รับการรองรับเพื่อความปลอดภัย" });
    }

    if (!bwipjs) bwipjs = require("bwip-js");
    const png = await bwipjs.toBuffer({
      bcid: type,
      text: value,
      scale: 3,
      height: 12,
      includetext: true,
      textxalign: "center"
    });

    res.setHeader("Content-Type", "image/png");
    res.send(png);
  } catch (e) {
    logger.error("[Barcode Gen Error]", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(400).json({ message: "ไม่สามารถสร้างบาร์โค้ดได้ กรุณาตรวจสอบข้อมูลสินค้า" });
  }
}

async function listWarehouses(req, res) {
  const rows = await prisma.warehouse.findMany({ orderBy: { code: "asc" } });
  res.json(rows);
}

async function createWarehouse(req, res) {
  try {
    const row = await prisma.warehouse.create({ data: { code: req.body.code, name: req.body.name } });
    logActivity(req, `เพิ่มคลังสินค้า: ${row.code} - ${row.name}`, "MasterData", row.id);

    res.status(201).json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function listZones(req, res) {
  const rows = await prisma.zone.findMany({ include: { warehouse: true }, orderBy: [{ warehouseId: "asc" }, { code: "asc" }] });
  res.json(rows);
}

async function createZone(req, res) {
  try {
    const row = await prisma.zone.create({
      data: { warehouseId: req.body.warehouseId, code: req.body.code, name: req.body.name },
      include: { warehouse: true }
    });
    logActivity(req, `เพิ่มโซนจัดเก็บ: ${row.code} (คลัง: ${row.warehouse.code})`, "MasterData", row.id);

    res.status(201).json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function listLocations(req, res) {
  const rows = await prisma.location.findMany({ include: { warehouse: true, zone: true }, orderBy: [{ warehouseId: "asc" }, { code: "asc" }] });
  res.json(rows);
}

async function createLocation(req, res) {
  try {
    const row = await prisma.location.create({
      data: { warehouseId: req.body.warehouseId, zoneId: req.body.zoneId, code: req.body.code, name: req.body.name },
      include: { warehouse: true, zone: true }
    });
    logActivity(req, `เพิ่มตำแหน่งจัดเก็บ: ${row.code} (คลัง: ${row.warehouse.code})`, "MasterData", row.id);

    res.status(201).json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function createProductBatch(req, res) {
  try {
    const { products } = req.body;
    if (!products || !products.length) return res.status(400).json({ message: "ไม่มีข้อมูลสินค้า" });
    const createdProducts = await prisma.$transaction(async (tx) => {
      const results = [];

      for (const item of products) {
        const cat = await tx.category.findUnique({ where: { id: item.categoryId } });
        const wh = item.warehouseId ? await tx.warehouse.findUnique({ where: { id: item.warehouseId } }) : null;

        const catAbbr = cat?.abbr || "GEN";
        const whCode = wh?.code || "WH";
        const prefix = `${catAbbr}-${whCode}-`;
        const lastProduct = await tx.product.findFirst({
          where: { sku: { startsWith: prefix } },
          orderBy: { sku: 'desc' },
          select: { sku: true }
        });

        let nextNumber = 1;
        if (lastProduct && lastProduct.sku) {
          const parts = lastProduct.sku.split('-');
          const lastPart = parts[parts.length - 1];
          const parsedNum = parseInt(lastPart, 10);
          if (!isNaN(parsedNum)) {
            nextNumber = parsedNum + 1;
          }
        }

        const finalSku = `${prefix}${String(nextNumber).padStart(4, '0')}`;
        const newProd = await tx.product.create({
          data: {
            sku: finalSku,
            name: item.name,
            categoryId: item.categoryId,
            unitId: item.unitId,
            warehouseId: item.warehouseId,
            zoneId: item.zoneId,
            locationId: item.locationId,
            barcodeValue: finalSku,
            barcodeType: "code128"
          }
        });
        results.push(newProd);
      }

      return results;
    });

    logActivity(req, `เพิ่มสินค้าใหม่แบบชุด (Batch) จำนวน ${createdProducts.length} รายการ`, "Product");
    res.status(201).json({ message: "Success", data: createdProducts });
  } catch (e) {
    logger.error("[Master] Create Batch Error", { error: e.message, ip: req.ip, userId: req.user?.id });
    res.status(500).json({ message: "ไม่สามารถรันรหัสสินค้าอัตโนมัติได้" });
  }
}

async function listDepartments(req, res) {
  try {
    const rows = await prisma.department.findMany({
      orderBy: { name: "asc" }
    });

    res.json(rows);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function createDepartment(req, res) {
  try {
    const { name } = req.body;
    const row = await prisma.department.create({ data: { name } });
    logActivity(req, `เพิ่มแผนกใหม่: ${row.name}`, "MasterData", row.id);
    res.status(201).json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function updateDepartment(req, res) {
  try {
    const { id } = req.params;
    const { name, isActive } = req.body;
    const row = await prisma.department.update({
      where: { id },
      data: { name, isActive }
    });
    logActivity(req, `แก้ไขข้อมูลแผนก: ${row.name}`, "MasterData", row.id);
    res.json(row);
  } catch (e) { handlePrismaError(e, res, req); }
}

async function deleteDepartment(req, res) {
  try {
    const dept = await prisma.department.findUnique({ where: { id: req.params.id } });
    await prisma.department.delete({ where: { id: req.params.id } });

    // 💡 [อัปเกรด Security] แจ้งเตือนการลบ
    if (dept) logActivity(req, `ลบแผนก: ${dept.name}`, "MasterData", dept.id, true);

    res.status(204).send();
  } catch (e) { handlePrismaError(e, res, req); }
}

const getSuppliers = async (req, res, next) => {
  try {
    const suppliers = await prisma.supplier.findMany({
      include: {
        _count: { select: { purchaseOrders: true } }
      },
      orderBy: { code: 'asc' }
    });
    res.json(suppliers);
  } catch (error) {
    next(error);
  }
};

const createSupplier = async (req, res, next) => {
  try {
    const { code, name, taxId, contactName, phone, email, address, creditDays } = req.body;

    const newSupplier = await prisma.supplier.create({
      data: {
        code, name, taxId, contactName, phone, email, address,
        creditDays: parseInt(creditDays) || 30
      }
    });

    logActivity(req, `เพิ่มข้อมูลคู่ค้าใหม่: ${name}`, "MasterData", newSupplier.id);
    res.status(201).json({ success: true, data: newSupplier });
  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ message: "รหัสคู่ค้านี้มีอยู่ในระบบแล้ว" });
    next(error);
  }
};

const getSupplierAnalytics = async (req, res, next) => {
  try {
    const { id } = req.params;
    const stats = await prisma.supplier.findUnique({
      where: { id },
      include: {
        purchaseOrders: {
          take: 10,
          orderBy: { createdAt: 'desc' },
          include: { user: { select: { firstName: true } } }
        }
      }
    });

    if (!stats) {
      // 💡 [อัปเกรด Security] ดักคนสุ่ม ID
      const safeId = req.params.id.replace(/[\r\n]/g, '');
      logger.warn(`[Master] พยายามดึงข้อมูลที่ไม่มีอยู่จริง (ID: ${safeId})`, { ip: req.ip, userId: req.user?.id });
      return res.status(404).json({ message: "ไม่พบข้อมูลคู่ค้า" });
    }

    const totalSpent = await prisma.purchaseOrder.aggregate({
      where: { supplierId: id, status: 'COMPLETED' },
      _sum: { totalAmount: true }
    });

    res.json({ ...stats, totalSpent: totalSpent._sum.totalAmount || 0 });
  } catch (error) {
    logger.error("[Master] Supplier Analytics Error", { error: error.message, ip: req.ip, userId: req.user?.id });
    next(error);
  }
};

const updateSupplier = async (req, res, next) => {
  try {
    const { id } = req.params;
    const allowedFields = ['name', 'taxId', 'contactName', 'phone', 'email', 'address', 'creditDays', 'avgLeadTime'];
    const updateData = {};

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = typeof req.body[field] === 'string' ? req.body[field].trim() : req.body[field];
      }
    });

    const updated = await prisma.supplier.update({
      where: { id },
      data: updateData
    });

    if (typeof logActivity === 'function') {
      logActivity(req, `แก้ไขข้อมูลคู่ค้า: ${updated.name} (ID: ${id})`, "MasterData", id);
    }

    res.json({ success: true, message: "บันทึกการเปลี่ยนแปลงสำเร็จ" });
  } catch (error) {
    logger.error("[Master] Update Supplier Error", { error: error.message, ip: req.ip, userId: req.user?.id });
    next(error);
  }
};

async function deleteWarehouse(req, res) {
  try {
    const { id } = req.params;
    const wh = await prisma.warehouse.findUnique({ where: { id } });
    await prisma.warehouse.delete({ where: { id } });

    // 💡 [อัปเกรด Security] แจ้งเตือนการลบคลัง (โครงสร้างใหญ่)
    if (wh) logActivity(req, `ลบคลังสินค้า: ${wh.code} - ${wh.name}`, "MasterData", id, true);

    res.status(204).send();
  } catch (e) { handlePrismaError(e, res, req); }
}

async function deleteZone(req, res) {
  try {
    const { id } = req.params;
    const zone = await prisma.zone.findUnique({ where: { id } });
    await prisma.zone.delete({ where: { id } });

    if (zone) logActivity(req, `ลบโซน: ${zone.code}`, "MasterData", id, true);

    res.status(204).send();
  } catch (e) { handlePrismaError(e, res, req); }
}

async function deleteLocation(req, res) {
  try {
    const { id } = req.params;
    const loc = await prisma.location.findUnique({ where: { id } });
    await prisma.location.delete({ where: { id } });

    if (loc) logActivity(req, `ลบตำแหน่งจัดเก็บ: ${loc.code}`, "MasterData", id, true);

    res.status(204).send();
  } catch (e) { handlePrismaError(e, res, req); }
}

module.exports = {
  listCategories, createCategory, updateCategory, deleteCategory,
  listUnits, createUnit, updateUnit, deleteUnit,
  listProducts, createProduct, updateProduct, getProductBarcodePng, deleteProduct,
  createProductBatch,
  listWarehouses, createWarehouse,
  listZones, createZone,
  listLocations, createLocation,
  listDepartments, createDepartment, updateDepartment, deleteDepartment,
  getSuppliers, createSupplier, getSupplierAnalytics,
  updateSupplier,
  deleteWarehouse, deleteZone, deleteLocation
};