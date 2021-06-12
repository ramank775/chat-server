function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}


function extractInfoFromRequest(req, key = 'user', defaultValue = null) {
    return req.headers[key] || req.state[key] || defaultValue;
}

function getUTCEpoch() {
    const now = new Date()
    const utcMilllisecondsSinceEpoch = now.getTime() + (now.getTimezoneOffset() * 60 * 1000)
    const utcSecondsSinceEpoch = Math.round(utcMilllisecondsSinceEpoch / 1000)
    return utcSecondsSinceEpoch;
}

module.exports = {
    uuidv4,
    extractInfoFromRequest,
    getUTCEpoch
}
