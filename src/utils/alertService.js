const axios = require('axios');
const logger = require('./logger');

async function sendSecurityAlert(message, reqDetails = {}) {
    const lineToken = process.env.LINE_NOTIFY_TOKEN; 
    if (!lineToken) return;

    const alertMsg = `\n🚨 [แจ้งเตือนความปลอดภัย]\n${message}\n\n🕵️ User: ${reqDetails.userId || 'Guest'}\n🌐 IP: ${reqDetails.ip}\n🔗 Path: ${reqDetails.path}\n🔑 Trace ID: ${reqDetails.reqId}`;

    try {
        await axios.post('https://notify-api.line.me/api/notify', 
            `message=${encodeURIComponent(alertMsg)}`, 
            {
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Bearer ${lineToken}`
                }
            }
        );
    } catch (error) {
        logger.error("ส่ง LINE แจ้งเตือนล้มเหลว", { error: error.message });
    }
}

module.exports = { sendSecurityAlert };