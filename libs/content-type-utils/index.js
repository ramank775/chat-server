const mappings = require('./content-type.mapping.json');
const defaultRecord = mappings[0];
module.exports.getContentTypeByExt = (ext) => {
    ext = ext ? ext.toLowerCase() : '';
    const record = mappings.find(x => x.ext === ext);
    return (record || defaultRecord)["context-type"]
}