var ws;


function getCookie(cname) {
    var name = cname + "=";
    var decodedCookie = decodeURIComponent(document.cookie);
    var ca = decodedCookie.split(';');
    for (var i = 0; i < ca.length; i++) {
        var c = ca[i];
        while (c.charAt(0) == ' ') {
            c = c.substring(1);
        }
        if (c.indexOf(name) == 0) {
            return c.substring(name.length, c.length);
        }
    }
    return "";
}

function getUserInfo() {
    const username = getCookie('user');
    const accesskey = getCookie('accesskey');
    return [username, accesskey];
}

function isLogin() {
    const [username, accesskey] = getUserInfo()
    return !!(username && accesskey)
}

function connect(username, accesskey) {
    let name = document.getElementById('name').value;
    if (!name) {
        alert("Name can't be empty");
        return;
    };
    document.getElementById('username').innerText = name;
    document.cookie = `user=${username}; path=/`;
    document.cookie = `accesskey=${accesskey}; path=/`
    connect_socket();
    document.getElementById('connection').style.display = "none";
}

function sendMessage() {
    let msg = document.getElementById('msg').value;
    let to = document.getElementById('to').value;
    let sMesgae = {
        message: msg,
        to: to
    }
    ws.send(JSON.stringify(sMesgae));
}

function connect_socket() {
    if (window.WebSocket) {

        console.log("WebSocket object is supported in your browser");

        const host = window.location.hostname;

        ws = new WebSocket(`wss://${host}/wss/`);

        ws.onopen = function () {
            document.getElementById('status').innerText = "Connected";
            console.log("onopen");
        };
        ws.onmessage = function (e) {
            const msgSpace = document.getElementById('message');
            const newMsgItem = document.createElement('li');
            newMsgItem.appendChild(document.createTextNode(e.data));
            msgSpace.appendChild(newMsgItem);
            console.log("echo from server : " + e.data);
        };

        ws.onclose = function () {
            console.log("onclose");
            document.getElementById('status').innerText = "Disconnected";
            document.getElementById('connection').style.display = "block";
        };
        ws.onerror = function () {
            console.log("onerror");
        };

    } else {
        console.log("WebSocket object is not supported in your browser");
    }
};

async function genEncryptionKey(password, mode, length) {
    var algo = {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: new TextEncoder().encode('a-unique-salt'),
        iterations: 1000
    };
    var derived = { name: mode, length: length };
    var encoded = new TextEncoder().encode(password);
    var key = await crypto.subtle.importKey('raw', encoded, { name: 'PBKDF2' }, false, ['deriveKey']);

    return crypto.subtle.deriveKey(algo, key, derived, false, ['encrypt', 'decrypt']);
}

// Encrypt function
async function encrypt(text, password, mode, length, ivLength) {
    var algo = {
        name: mode,
        length: length,
        iv: crypto.getRandomValues(new Uint8Array(ivLength))
    };
    var key = await genEncryptionKey(password, mode, length);
    var encoded = new TextEncoder().encode(text);

    return {
        cipherText: await crypto.subtle.encrypt(algo, key, encoded),
        iv: algo.iv
    };
}



function setupUI() {
    if (!isLogin()) {
        document.getElementById('div_reg').style.visibility = true;
        document.getElementById('div_login').style.visibility = true;
        document.getElementById('div_loggedIn').style.visibility = false;
        let isAvailable = false;
        document.getElementById('reg_username').onchange = (event) => {
            if (event.target.value && event.target.value.length > 4) {
                post('/exit', {
                    method: 'post',
                    headers: new Headers({
                        'Content-Type': 'application/json'
                    }),
                    body: JSON.stringify({ username: event.target.value })
                }).then(response => response.json())
                    .then(({ status }) => {
                        isAvailable = status;
                        document.getElementById('reg_submit').style.visibility = status;
                    });
            }
        }
        let isRegSubmit = false;
        document.getElementById('reg_submit').onclick = async (event) => {
            if (!isAvailable)
                return;
            let values = {
                name: document.getElementById('reg_name').value,
                username: document.getElementById('reg_username').value
            }
            let password = document.getElementById('reg_password');
            const { cipherText } = await encrypt(values.username, password, 'AES-GCM', 256, 12);
            const decoder = TextDecoder();
            values.secretPhase = decoder.decode(cipherText);
            fetch('/register', {
                method: 'post',
                body: JSON.stringify(values),
                headers: new Headers({
                    'Content-Type': 'application/json'
                })
            }).then(res => res.json())
                .then(res => {
                    connect(res.username, res.accesskey);
                    setupUI();
                })
        }

        document.getElementById('login_submit').onclick = (event) => {
            const username = document.getElementById('login_username').value;
            const password = document.getElementById('login_password').value;
            if (!(username && password)) {
                return;
            }
            const { cipherText } = await encrypt(values.username, password, 'AES-GCM', 256, 12);
            const decoder = TextDecoder();
            const secretPhase = decoder.decode(cipherText);
            fetch('/login', {
                method: 'post',
                body: JSON.stringify(values),
                headers: new Headers({
                    'Content-Type': 'application/json'
                })
            }).then(res => res.json())
                .then(res => {
                    if (!res.status) {
                        alert('Loggin failed');
                        return;
                    }
                    connect(res.username, res.accesskey);
                    setupUI();
                })
        }
    }
    else {
        document.getElementById('div_reg').style.visibility = false;
        document.getElementById('div_login').style.visibility = false;
        document.getElementById('div_loggedIn').style.visibility = true;

        document.getElementById('msg_submit').onclick = sendMessage;
    }
}


window.onload = () => {
    setupUI();
    if (isLogin()) {
        const [username, accesskey] = getUserInfo();
        connect(username, accesskey);
    }
}

