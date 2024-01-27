/// <reference path="messaging.js" />

// eslint-disable-next-line node/no-unsupported-features/es-syntax, import/extensions
import { Messaging, Message } from './messaging.js';

/* eslint-env browser */

/* eslint-disable no-console */

// eslint-disable-next-line
let channels = [];

const events = new Map();
// eslint-disable-next-line no-var
// var Messaging;
// eslint-disable-next-line no-var
// var Message;

/** @type {Messaging} */
let messaging;

function getCookie(cname) {
  const name = `${cname}=`;
  const decodedCookie = decodeURIComponent(document.cookie);
  const ca = decodedCookie.split(';');
  for (let i = 0; i < ca.length; i += 1) {
    let c = ca[i];
    while (c.charAt(0) === ' ') {
      c = c.substring(1);
    }
    if (c.indexOf(name) === 0) {
      return c.substring(name.length, c.length);
    }
  }
  return '';
}

function setCookie(cname, cvalue, exdays) {
  const d = new Date();
  d.setTime(d.getTime() + exdays * 24 * 60 * 60 * 1000);
  const expires = `expires=${d.toUTCString()}`;
  document.cookie = `${cname}=${cvalue};${expires};path=/`;
}

function getUserInfo() {
  const username = getCookie('user');
  const accesskey = getCookie('accesskey');
  return [username, accesskey];
}


async function login(username, authtoken) {
  return Messaging.login({
    username,
    authToken: authtoken,
    notificationToken: 'testing-token',
    deviceId: 'default'
  })
    .then((res) => {
      setCookie('user', username, 1000);
      setCookie('accesskey', res.accesskey, 1000);
    })
    .catch((err) => {
      console.log(err);
    });
}

function isLogin() {
  const [username, accesskey] = getUserInfo();
  return !!(username && accesskey);
}

function showGroups() {
  const groupSpace = document.getElementById('groups')
  groupSpace.innerHTML = '';
  channels.forEach(g => {
    const newGroup = document.createElement('li');
    newGroup.id = g.channelId
    const name = document.createElement('span')
    name.textContent = g.name
    newGroup.appendChild(name)
    newGroup.onclick = function groupClick() {
      document.getElementById('to').value = g.channelId
      document.getElementById('msg_channel').value = 'GROUP';
    }
    groupSpace.appendChild(newGroup)
  })
}

function getGroups() {
  messaging.getGroups()
    .then((res) => {
      channels = res;
      showGroups()
    });
}

function createGroup() {
  const groupName = document.getElementById('group_name').value;
  const groupMembers = document.getElementById('group_member').value.split(',');

  messaging.createGroup(groupName, groupMembers)
    .then((res) => {
      console.log(res);
      getGroups();
    });
}

function switchToEventTab() {
  document.getElementById('div_group').style.display = 'none';
  document.getElementById('event_viewer').style.display = 'block';
}

function switchToGroupTab() {
  getGroups();
  document.getElementById('div_group').style.display = 'block';
  document.getElementById('event_viewer').style.display = 'none';
}

function showEventDetail(id) {
  const event = events.get(id)
  if (!event) return;
  document.getElementById('json').textContent = JSON.stringify(event, undefined, 2)
  switchToEventTab()
}

function displayEvent(message) {
  const id = `${message.id}_${message.type}`
  events.set(id, message)
  const msgSpace = document.getElementById('message');
  const newMsgItem = document.createElement('li');
  newMsgItem.id = id;
  newMsgItem.onclick = function onEventClick() {
    showEventDetail(id)
  }
  newMsgItem.classList.add(message.type.toLowerCase())
  const headElm = document.createElement('span')
  headElm.textContent = message.type
  newMsgItem.appendChild(headElm)
  newMsgItem.appendChild(document.createElement('br'))
  const contentElm = document.createElement('span')
  contentElm.textContent = JSON.stringify(message.content || '')
  newMsgItem.appendChild(contentElm)
  msgSpace.appendChild(newMsgItem);
}

async function sendMessage() {
  const msg = new Message();
  msg.channel = document.getElementById('msg_channel').value;
  msg.type = document.getElementById('type').value;
  msg.destination = document.getElementById('to').value;
  msg.ephemeral = document.getElementById('ephemeral').checked;
  msg.timestamp = Math.floor(Date.now() / 1000);
  msg.content = JSON.parse(document.getElementById('content').value);
  msg.meta = JSON.parse(document.getElementById('meta').value);
  await messaging.send(msg);
}

function setupUI() {
  if (!isLogin()) {
    document.getElementById('div_login').style.display = 'block';
    document.getElementById('div_loggedIn').style.display = 'none';

    document.getElementById('login_submit').onclick = async (_event) => {
      const username = document.getElementById('login_username').value;
      if (!username) {
        return;
      }
      login(username, 'test').then(() => {
        setupUI();
      });
    };
  } else {
    messaging = new Messaging({
      get: getUserInfo
    })
    document.getElementById('div_login').style.display = 'none';
    document.getElementById('div_loggedIn').style.display = 'block';
    const [username] = getUserInfo();
    document.getElementById('username').innerText = username;
    messaging.connectSocket();
    messaging.addEventListener('connection', (event) => {
      document.getElementById('status').innerText = event.detail.status;
    })
    messaging.addEventListener('message', (event) => displayEvent(event.detail));
    document.getElementById('create_group').onclick = createGroup;
    document.getElementById('channel').onchange = (e) => {
      const event = new Message()
      event.id = `local_${Date.now()}`
      event.type = 'channel'
      event.content = `Channel change from ${messaging.channel} to ${e.target.value}`
      event.source = 'local';
      messaging.updateMessageChannel(e.target.value)
      displayEvent(event)
    }
    document.getElementById('version').onchange = e => {
      const event = new Message()
      event.id = `local_${Date.now()}`
      event.type = 'version'
      event.content = `Version change from ${messaging.message_version} to ${e.target.value}`
      event.source = 'local';
      messaging.updateMessageVersion(Number(e.target.value))
      displayEvent(event)
    }
    document.getElementById('server-ack').checked = messaging.server_ack;
    document.getElementById('client-ack').checked = messaging.client_ack;
    document.getElementById('server-ack').onchange = e => {
      const event = new Message()
      event.id = `local_${Date.now()}`
      event.type = 'server_ack'
      event.content = `Server ack is ${e.target.checked ? 'enabled' : 'disabled'}`
      event.source = 'local';
      if (e.target.checked) {
        messaging.enableServerAck();
      } else {
        messaging.disableServerAck()
      }
      displayEvent(event)
    }
    document.getElementById('client-ack').onchange = e => {
      const event = new Message()
      event.id = `local_${Date.now()}`
      event.type = 'client-ack'
      event.content = `Client ack is ${e.target.checked ? 'enabled' : 'disabled'}`
      event.source = 'local';
      if (e.target.checked) {
        messaging.enableClientAck()
      } else {
        messaging.disableClientAck()
      }
      displayEvent(event)
    }
    document.getElementById('group_tab').onclick = () => switchToGroupTab();
    document.getElementById('event_tab').onclick = () => switchToEventTab();
    document.getElementById('msg_submit').onclick = () => sendMessage();
  }
}

window.onload = () => {
  setupUI();
};
