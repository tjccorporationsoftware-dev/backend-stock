const express = require('express');
const router = express.Router();
const { requireAuth } = require('../../middlewares/authJwt');
const { requirePermissions } = require('../../middlewares/requirePerm');
const countTaskController = require('./countTask.controller');


const READ_COUNT = ['INVENTORY_READ'];
const MANAGE_COUNT = ['COUNT_TASK_MANAGE'];

router.post('/', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.createCountTask);
router.put('/:id/scan', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.saveCountData);
router.post('/:id/complete', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.completeCountTask);
router.delete('/:id', requireAuth, requirePermissions(MANAGE_COUNT), countTaskController.deleteCountTask);
router.get('/', requireAuth, requirePermissions(READ_COUNT), countTaskController.listCountTasks);
router.get('/:id', requireAuth, requirePermissions(READ_COUNT), countTaskController.getCountTaskDetail);
router.get('/:id/pdf', requireAuth, requirePermissions(READ_COUNT), countTaskController.generateCountTaskPDF);
module.exports = { countTaskRoutes: router };