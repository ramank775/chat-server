const { getUTCEpoch } = require('../helper');

function formatMessage(message) {
    const { META, payload } = message;
    const parsedPayload = JSON.parse(payload);
    const msg = {
        _v: parsedPayload._v || 1.0,
    };

    if (msg._v >= 2.0) {
        const { id, head, meta, body } = parsedPayload;
        head.from = META.from;
        msg.head = head;
        msg.id = id;
        msg.body = body;
        msg.body.ts = getUTCEpoch();

        Object.assign(META, meta);
        META.to = head.to;
        META.id = id;
        META.type = head.type;
        META.contentType = head.contentType
        META.action = head.action

        // Add legacy keys for backward compatibility
        // TODO: remove this in next stable build
        msg.from = META.from;
        msg.to = head.to;
        msg.msgId = id;
        msg.type = head.contentType;
        msg.chatId = head.chatId; // to be deperciated, added for backward comptibility only
        msg.text = body.text;
        msg.module = head.type;
        msg.action = head.action;
        msg.chatType = head.type;

    } else {
        const { to, type, chatType, ..._msg } = parsedPayload;
        Object.assign(msg, _msg);
        msg.from = META.from;
        msg.to = to;
        msg.type = type;
        msg.chatType = chatType;

        // Add new format keys
        msg.id = msg.msgId;
        msg.head = {
            type: chatType || msg.module,
            to: to,
            from: META.from,
            chatid: msg.chatId,
            contentType: msg.type,
            action: msg.action || 'message'
        };
        msg.body = {
            text: _msg.text,
            ts: getUTCEpoch()
        };

        Object.assign(META, {
            to: to,
            id: msg.id,
            type: chatType,
            contentType: type,
            action: msg.head.action
        })
    }

    const formattedMessage = {
        META: { ...META, parsed: true },
        payload: msg
    }
    return formattedMessage;
}

module.exports = {
    formatMessage
}
