// logger.js — tee all console output to log.log as well as stdout/stderr
const fs   = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'log.log');

function timestamp() {
    return new Date().toISOString();
}

function write(line) {
    fs.appendFileSync(LOG_FILE, line + '\n');
}

const _log   = console.log.bind(console);
const _error = console.error.bind(console);
const _warn  = console.warn.bind(console);

console.log = (...args) => {
    const line = `[${timestamp()}] ${args.join(' ')}`;
    _log(...args);
    write(line);
};

console.error = (...args) => {
    const line = `[${timestamp()}] ERROR ${args.join(' ')}`;
    _error(...args);
    write(line);
};

console.warn = (...args) => {
    const line = `[${timestamp()}] WARN ${args.join(' ')}`;
    _warn(...args);
    write(line);
};

// Log a visible separator each time the process starts
write(`\n${'='.repeat(60)}`);
write(`[${timestamp()}] Process started — PID ${process.pid}`);
write('='.repeat(60));
