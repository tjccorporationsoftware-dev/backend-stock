const express = require('express');
const router = express.Router();
const settingsController = require('./settings.controller');
const { requireAuth } = require('../../middlewares/authJwt');;

const { requirePermissions } = require('../../middlewares/requirePerm');


router.post('/company', requireAuth, requirePermissions(['SYSTEM_SETTINGS_MANAGE']), settingsController.updateCompanySettings);
router.get('/company', requireAuth, settingsController.getCompanySettings);




module.exports = { settingsRoutes: router };