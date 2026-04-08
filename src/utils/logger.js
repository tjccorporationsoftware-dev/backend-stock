const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// 💡 [เพิ่ม] สร้าง Format สำหรับจัดการ Log Injection โดยเฉพาะ
const sanitizeLog = winston.format((info) => {
    if (typeof info.message === 'string') {
        // ลบอักขระขึ้นบรรทัดใหม่เพื่อป้องกันการปลอมแปลง Log
        info.message = info.message.replace(/[\r\n]/g, ' ');
    }
    // ตรวจสอบในกรณีที่มีการส่ง Metadata มาด้วย
    for (const key in info) {
        if (typeof info[key] === 'string' && key !== 'timestamp') {
            info[key] = info[key].replace(/[\r\n]/g, ' ');
        }
    }
    return info;
});

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        sanitizeLog(), // 💡 เรียกใช้งานตัว Sanitize ก่อน Format อื่นๆ
        winston.format.timestamp(),
        winston.format.json() 
    ),
    transports: [
        new winston.transports.Console({ 
            format: winston.format.combine(
                winston.format.colorize(), 
                winston.format.simple()
            ) 
        }),
        new DailyRotateFile({
            filename: 'logs/security-%DATE%.log', 
            datePattern: 'YYYY-MM-DD',
            level: 'warn', 
            maxFiles: '30d' 
        })
    ],
});

module.exports = logger;