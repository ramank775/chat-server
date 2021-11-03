var ws;
var groups = [];
var id = 0;
var enableAck = true;

function getCookie(cname) {
  var name = cname + '=';
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
  return '';
}

function setCookie(cname, cvalue, exdays) {
  var d = new Date();
  d.setTime(d.getTime() + exdays * 24 * 60 * 60 * 1000);
  var expires = 'expires=' + d.toUTCString();
  document.cookie = cname + '=' + cvalue + ';' + expires + ';path=/';
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
  const [username, accesskey] = getUserInfo();
  return !!(username && accesskey);
}

function connect() {
  const [username] = getUserInfo();
  document.getElementById('username').innerText = username;
  connect_socket();
}

function sendMessage(version) {
  const [username] = getUserInfo();
  function getChatId(to) {
    const values = [username.replace('+', ''), to.replace('+', '')].sort();
    return values.join('');
  }
  let msg = document.getElementById('msg').value;
  let to = document.getElementById('to').value;
  let sMessage;
  if (version == 1) {
    sMessage = {
      msgId: get_msgid(to),
      text: msg,
      to: to,
      chatId: getChatId(to),
      type: 'text',
      chatType: groups.filter((x) => x.groupId == to).length > 0 ? 'group' : 'INDIVIDUAL'
    };
  } else {
    sMessage = {
      _v: 2.0,
      id: get_msgid(to),
      head: {
        type: groups.filter((x) => x.groupId == to).length > 0 ? 'group' : 'INDIVIDUAL',
        to: to,
        from: username,
        chatid: getChatId(to), // to be deperciated, added for backward comptibility only
        contentType: 'text',
        action: 'message'
      },
      meta: {
        hash: 'md5:hash',
        content_hash: 'md5:hash',
        generate_ts: Date.now()
      },
      body: {
        text: msg
      }
    };
  }
  ws.send(JSON.stringify(sMessage));
}

function get_msgid(to) {
  return to + Date.now() + ++id;
}

function getGroups() {
  fetch('/group/get')
    .then((res) => res.json())
    .then((res) => {
      console.log(res);
      const group_space = document.getElementById('groups');
      group_space.innerHTML = '';
      res.forEach((group) => {
        const newGroup = document.createElement('li');
        newGroup.appendChild(document.createTextNode(JSON.stringify(group)));
        group_space.appendChild(newGroup);
      });
      groups = res;
    });
}

function createGroup() {
  let groupName = document.getElementById('group_name').value;
  let groupMembers = document.getElementById('group_member').value.split(',');
  let payload = {
    name: groupName,
    members: groupMembers,
    profilePic: null
  };
  fetch('/group/create', {
    method: 'post',
    body: JSON.stringify(payload),
    headers: new Headers({
      'Content-Type': 'application/json'
    })
  })
    .then((res) => res.json())
    .then((res) => {
      console.log(res);
      getGroups();
    });
}

function send_ack(payload) {
  if (!enableAck) return;
  const [username] = getUserInfo();
  const messages = JSON.parse(payload);
  const acks = messages.map((msg) => {
    return {
      _v: 2.0,
      id: `${msg.id}_ack`,
      meta: {
        hash: 'md5:hash',
        content_hash: 'md5:hash',
        generate_ts: Date.now() / 1000
      },
      head: {
        ...msg.head,
        to: msg.head.from,
        from: username,
        action: 'ack'
      },
      body: {
        ids: [msg.id]
      }
    };
  });
  acks.forEach((ack) => {
    ws.send(JSON.stringify(ack));
  });
  console.log('Ack sent');
}

function connect_socket() {
  if (window.WebSocket) {
    console.log('WebSocket object is supported in your browser');

    const host = window.location.hostname;
    const startTime = Date.now();
    ws = new WebSocket(`wss://${host}/wss/`);

    ws.onopen = function () {
      console.log('connection time', Date.now() - startTime);
      document.getElementById('status').innerText = 'Connected';
      console.log('onopen');
    };
    ws.onmessage = function (e) {
      const msgSpace = document.getElementById('message');
      const newMsgItem = document.createElement('li');

      console.log(e.data);
      send_ack(e.data);
      newMsgItem.appendChild(document.createTextNode(e.data));
      msgSpace.appendChild(newMsgItem);
      console.log('echo from server : ' + e.data);
    };

    ws.onclose = function () {
      console.log('onclose');
      document.getElementById('status').innerText = 'Disconnected';
    };
    ws.onerror = function () {
      console.log('onerror');
    };
  } else {
    console.log('WebSocket object is not supported in your browser');
  }
}

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
        })
          .then((response) => response.json())
          .then(({ status }) => {
            isAvailable = !status;
            document.getElementById('reg_submit').style.display = !status ? 'block' : 'none';
          });
      }
    };
    let isRegSubmit = false;
    document.getElementById('reg_submit').onclick = async (event) => {
      if (!isAvailable) return;
      let values = {
        name: document.getElementById('reg_name').value,
        username: document.getElementById('reg_username').value,
        secretPhase: document.getElementById('reg_password').value
      };
      fetch('/register', {
        method: 'post',
        body: JSON.stringify(values),
        headers: new Headers({
          'Content-Type': 'application/json'
        })
      })
        .then((res) => res.json())
        .then((res) => {
          login(res.username, res.accesskey);
          setupUI();
        });
    };

    document.getElementById('login_submit').onclick = async (event) => {
      const username = document.getElementById('login_username').value;
      const secretPhase = document.getElementById('login_password').value;
      if (!(username && secretPhase)) {
        return;
      }
      login(username, 'test');
      setupUI();
      // fetch('/login', {
      //     method: 'post',
      //     body: JSON.stringify({
      //         username,
      //         secretPhase
      //     }),
      //     headers: new Headers({
      //         'Content-Type': 'application/json'
      //     })
      // }).then(res => res.json())
      //     .then(res => {
      //         if (!res.status) {
      //             alert('Loggin failed');
      //             return;
      //         }
      //         login(res.username, res.accesskey);
      //         setupUI();
      //     })
    };
  } else {
    document.getElementById('div_reg').style.display = 'none';
    document.getElementById('div_login').style.display = 'none';
    document.getElementById('div_loggedIn').style.display = 'block';

    document.getElementById('msg_submit_v2').onclick = () => sendMessage(2);
    document.getElementById('msg_submit_v1').onclick = () => sendMessage(1);

    connect();
    document.getElementById('create_group').onclick = createGroup;
    getGroups();
  }
}

window.onload = () => {
  setupUI();
};
