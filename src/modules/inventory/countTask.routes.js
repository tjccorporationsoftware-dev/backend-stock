const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middlewares/authJwt');
const { requirePermissions } = require('../../middlewares/requirePerm');
const countTaskController = require('./countTask.controller');


const MANAGE_COUNT = ['INVENTORY_READ'];

router.post('/', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.createCountTask);
router.get('/', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.listCountTasks);
router.get('/:id', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.getCountTaskDetail);
router.put('/:id/scan', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.saveCountData);
router.post('/:id/complete', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.completeCountTask);
router.get('/:id/pdf', requireAuth, countTaskController.generateCountTaskPDF);
router.delete('/:id', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.deleteCountTask);

module.exports = { countTaskRoutes: router };