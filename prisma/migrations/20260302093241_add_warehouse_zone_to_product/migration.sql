-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "warehouseId" TEXT,
ADD COLUMN     "zoneId" TEXT;

-- CreateIndex
CREATE INDEX "Product_warehouseId_idx" ON "Product"("warehouseId");

-- CreateIndex
CREATE INDEX "Product_zoneId_idx" ON "Product"("zoneId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_warehouseId_fkey" FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "Zone"("id") ON DELETE SET NULL ON UPDATE CASCADE;
