const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middlewares/authJwt');
const { requirePermissions } = require('../../middlewares/requirePerm');
const reportsController = require('./reports.controller');


router.get(
    '/export/inventory/excel',
    requireAuth,
    requirePermissions(['REPORT_EXPORT']),
    reportsController.exportInventoryExcel
);

router.get(
    '/export/inventory/pdf',
    requireAuth,
    requirePermissions(['REPORT_EXPORT']),
    reportsController.exportInventoryPDF
);

router.get(
    '/export/movement/excel',
    requireAuth,
    requirePermissions(['REPORT_EXPORT']),
    reportsController.exportMovementExcel
);

module.exports = { reportsRoutes: router };