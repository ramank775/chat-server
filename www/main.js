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

function setCookie(cname, cvalue, exdays) {
  var d = new Date();
  d.setTime(d.getTime() + (exdays*24*60*60*1000));
  var expires = "expires="+ d.toUTCString();
  document.cookie = cname + "=" + cvalue + ";" + expires + ";path=/";
}

function getUserInfo() {
    const username = getCookie('user');
    const accesskey = getCookie('accesskey');
    return [username, accesskey];
}

function login(username, accesskey) {
    setCookie('user', username, 1000);
    setCookie('accesskey', accesskey, 1000);
}

function isLogin() {
    const [username, accesskey] = getUserInfo()
    return !!(username && accesskey)
}

function connect() {
    const [username] = getUserInfo();
    document.getElementById('username').innerText = username;
    connect_socket();
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
            console.log(e.data);
            newMsgItem.appendChild(document.createTextNode(e.data));
            msgSpace.appendChild(newMsgItem);
            console.log("echo from server : " + e.data);
        };

        ws.onclose = function () {
            console.log("onclose");
            document.getElementById('status').innerText = "Disconnected";
        };
        ws.onerror = function () {
            console.log("onerror");
        };

    } else {
        console.log("WebSocket object is not supported in your browser");
    }
};

function setupUI() {
    if (!isLogin()) {
        document.getElementById('div_reg').style.display = 'block';
        document.getElementById('div_login').style.display = 'block';
        document.getElementById('div_loggedIn').style.display = 'none';
        let isAvailable = false;
        document.getElementById('reg_username').onchange = (event) => {
            if (event.target.value && event.target.value.length > 4) {
                fetch('/exist', {
                    method: 'post',
                    headers: new Headers({
                        'Content-Type': 'application/json'
                    }),
                    body: JSON.stringify({ username: event.target.value })
                }).then(response => response.json())
                    .then(({ status }) => {
                        isAvailable = !status;
                        document.getElementById('reg_submit').style.display = !status?'block':'none';
                    });
            }
        }
        let isRegSubmit = false;
        document.getElementById('reg_submit').onclick = async (event) => {
            if (!isAvailable)
                return;
            let values = {
                name: document.getElementById('reg_name').value,
                username: document.getElementById('reg_username').value,
                secretPhase: document.getElementById('reg_password').value
            }
            fetch('/register', {
                method: 'post',
                body: JSON.stringify(values),
                headers: new Headers({
                    'Content-Type': 'application/json'
                })
            }).then(res => res.json())
                .then(res => {
                    login(res.username, res.accesskey);
                    setupUI();
                    
                })
        }

        document.getElementById('login_submit').onclick = async (event) => {
            const username = document.getElementById('login_username').value;
            const secretPhase = document.getElementById('login_password').value;
            if (!(username && secretPhase)) {
                return;
            }
            fetch('/login', {
                method: 'post',
                body: JSON.stringify({
                    username,
                    secretPhase
                }),
                headers: new Headers({
                    'Content-Type': 'application/json'
                })
            }).then(res => res.json())
                .then(res => {
                    if (!res.status) {
                        alert('Loggin failed');
                        return;
                    }
                    login(res.username, res.accesskey);
                    setupUI();
                })
        }
    }
    else {
        document.getElementById('div_reg').style.display = 'none';
        document.getElementById('div_login').style.display = 'none';
        document.getElementById('div_loggedIn').style.display = 'block';

        document.getElementById('msg_submit').onclick = sendMessage;
        connect();
    }
}


window.onload = () => {
    setupUI();
}

