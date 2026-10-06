const fs = require('node:fs');
const magic = Buffer.from('VRCX-INSTALL-CONFIG-V1');
const footerSize = magic.length + 4;
const maxSize = 65536;

function validate(config) {
    const url = new URL(config.server);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        typeof config.token !== 'string' || !config.token || config.token.length > 4096) {
        throw new Error('Invalid embedded installer configuration.');
    }
    return config;
}

function installerConfigTrailer(config) {
    const json = Buffer.from(JSON.stringify(validate(config)));
    if (json.length > maxSize) throw new Error('Installer configuration is too large.');
    const size = Buffer.alloc(4);
    size.writeUInt32LE(json.length);
    return Buffer.concat([json, size, magic]);
}

function readInstallerConfig(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        if (size < footerSize) return null;
        const footer = Buffer.alloc(footerSize);
        fs.readSync(fd, footer, 0, footerSize, size - footerSize);
        if (!footer.subarray(4).equals(magic)) return null;
        const length = footer.readUInt32LE(0);
        if (!length || length > maxSize || length > size - footerSize) throw new Error('Invalid installer configuration length.');
        const json = Buffer.alloc(length);
        fs.readSync(fd, json, 0, length, size - footerSize - length);
        return validate(JSON.parse(json.toString('utf8')));
    } finally { fs.closeSync(fd); }
}

module.exports = { installerConfigTrailer, readInstallerConfig };
