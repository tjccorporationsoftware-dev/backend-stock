const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json() // เก็บเป็น JSON
    ),
    transports: [
        new winston.transports.Console({ 
            format: winston.format.combine(winston.format.colorize(), winston.format.simple()) 
        }),
        // เก็บ Log ความปลอดภัยโดยเฉพาะ
        new DailyRotateFile({
            filename: 'logs/security-%DATE%.log', 
            datePattern: 'YYYY-MM-DD',
            level: 'warn', // เก็บเฉพาะ Warn และ Error
            maxFiles: '30d' 
        })
    ],
});

module.exports = logger;