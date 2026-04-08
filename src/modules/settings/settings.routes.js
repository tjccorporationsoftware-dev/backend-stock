const express = require('express');
const router = express.Router();
const settingsController = require('./settings.controller');
const { requireAuth } = require('../../middlewares/authJwt');;


router.get('/company', requireAuth, settingsController.getCompanySettings);


router.post('/company', requireAuth, settingsController.updateCompanySettings);


module.exports = { settingsRoutes: router };