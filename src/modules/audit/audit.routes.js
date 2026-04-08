const express = require("express");
const { requireAuth } = require("../../middlewares/authJwt");
const { requirePermissions } = require("../../middlewares/requirePerm");
const { listAuditLogs, getAuditFilters } = require("./audit.controller");
const router = express.Router();


const AUDIT_KEY = "AUDIT_LOG_VIEW";

router.get("/filters", requireAuth, requirePermissions([AUDIT_KEY]), getAuditFilters);
router.get("/", requireAuth, requirePermissions([AUDIT_KEY]), listAuditLogs);

module.exports = { auditRoutes: router };