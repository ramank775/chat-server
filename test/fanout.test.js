const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('path');
const protobufjs = require('protobufjs');
const { EnvelopeEvent, SERVER_EVENT_MARKER } = require('../libs/v3-envelope');
const { startProfileMs, signupWithUsername, bearer } = require('./helpers/profile-ms');

const ServerEventPayload = protobufjs
  .loadSync(join(__dirname, '..', 'proto', 'v3-server-event-payload.proto'))
  .lookupType('vartalap.v3.payload.ServerEventPayload');

describe('REST-write fanout (SYNC_PROTOCOL 10.2)', () => {
  /** @type {Awaited<ReturnType<typeof startProfileMs>>} */
  let app;

  before(async () => {
    app = await startProfileMs('profile_ms_test_fanout');
  });

  after(async () => {
    await app.stop();
  });

  const patch = (accesskey, payload) =>
    app.inject({ method: 'PATCH', url: '/users/me', headers: bearer(accesskey), payload });

  /**
   * The server-event envelopes published since `from`, decoded. Each one is
   * put through the bus codec first: the memory store hands the object back
   * untouched, a real broker does not.
   */
  const emitted = (from) =>
    app.eventStore.events.slice(from).map(({ event, args, key }) => {
      const { envelope, recipients } = EnvelopeEvent.fromBinary(args.toBinary());
      assert.equal(event, 'new-message', 'fanout rides the chat topic');
      assert.equal(key, envelope.channelId, 'partitioned by channel like a chat envelope');
      assert.equal(envelope.payload[0], SERVER_EVENT_MARKER, 'payload is marked server authored');
      assert.equal(envelope.senderUserId, '', 'no user authored this');
      return {
        recipients,
        channelId: envelope.channelId,
        deliverySequence: envelope.deliverySequence,
        body: ServerEventPayload.toObject(
          ServerEventPayload.decode(envelope.payload.subarray(1)),
          { defaults: false }
        )
      };
    });

  test('a profile edit reaches every co-member exactly once, and never the editor', async () => {
    const editor = await signupWithUsername(app, { phone: '+919500000001', username: 'editor_one' });
    const peer = await signupWithUsername(app, { phone: '+919500000002', username: 'peer_one' });
    const groupMate = await signupWithUsername(app, {
      phone: '+919500000003',
      username: 'mate_one'
    });
    await signupWithUsername(app, { phone: '+919500000004', username: 'stranger_one' });

    app.stubChannels([
      {
        channelId: 'dm-1',
        type: 'one_to_one',
        members: [{ user_id: editor.user_id }, { user_id: peer.user_id }]
      },
      {
        channelId: 'group-1',
        type: 'group',
        // the same peer in a second channel: still one envelope for them
        members: [
          { user_id: editor.user_id },
          { user_id: peer.user_id },
          { user_id: groupMate.user_id }
        ]
      },
      {
        channelId: 'group-2',
        type: 'group',
        members: [{ user_id: peer.user_id }, { user_id: groupMate.user_id }]
      }
    ]);

    const from = app.eventStore.events.length;
    const res = await patch(editor.accesskey, { displayName: 'Editor One', statusText: null });
    assert.equal(res.statusCode, 200);

    const events = emitted(from);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].recipients.sort(), [peer.user_id, groupMate.user_id].sort());
    assert.equal(events[0].body.type, 6, 'PROFILE_EDITED');
    assert.equal(events[0].body.profileEdited.userId, editor.user_id);
    assert.equal(events[0].body.profileEdited.displayName, 'Editor One');
    assert.equal(
      events[0].body.profileEdited.statusText,
      '',
      'present and empty means the field was cleared'
    );
    assert.equal(
      'avatarUrl' in events[0].body.profileEdited,
      false,
      'an untouched field is absent, not empty'
    );
    assert.ok(events[0].deliverySequence > 0);
  });

  test('a username change fans UsernameChanged alongside the profile event', async () => {
    const editor = await signupWithUsername(app, { phone: '+919500000005', username: 'editor_two' });
    const peer = await signupWithUsername(app, { phone: '+919500000006', username: 'peer_two' });
    app.stubChannels([
      {
        channelId: 'dm-2',
        type: 'one_to_one',
        members: [{ user_id: editor.user_id }, { user_id: peer.user_id }]
      }
    ]);

    const from = app.eventStore.events.length;
    const res = await patch(editor.accesskey, { username: 'editor_two_b', avatarUrl: 'http://a/b' });
    assert.equal(res.statusCode, 200);

    const events = emitted(from);
    assert.equal(events.length, 2);
    events.forEach((event) => assert.deepEqual(event.recipients, [peer.user_id]));
    assert.equal(events[0].body.type, 6, 'PROFILE_EDITED first');
    assert.equal(events[0].body.profileEdited.avatarUrl, 'http://a/b');
    assert.equal(events[1].body.type, 7, 'then USERNAME_CHANGED');
    assert.deepEqual(events[1].body.usernameChanged.userId, editor.user_id);
    assert.equal(events[1].body.usernameChanged.newUsername, 'editor_two_b');
  });

  test('nothing is emitted without a change, a co-member, or a channel', async () => {
    const editor = await signupWithUsername(app, {
      phone: '+919500000007',
      username: 'editor_three'
    });

    // channel-ms knows of no channel for this user
    app.stubChannels([]);
    let from = app.eventStore.events.length;
    assert.equal((await patch(editor.accesskey, { displayName: 'Alone' })).statusCode, 200);
    assert.deepEqual(emitted(from), []);

    // a channel the editor shares with nobody
    app.stubChannels([
      { channelId: 'solo-1', type: 'group', members: [{ user_id: editor.user_id }] }
    ]);
    from = app.eventStore.events.length;
    assert.equal((await patch(editor.accesskey, { displayName: 'Still alone' })).statusCode, 200);
    assert.deepEqual(emitted(from), []);

    // re-sending the username they already hold is a no-op (decision 31)
    const peer = await signupWithUsername(app, { phone: '+919500000008', username: 'peer_three' });
    app.stubChannels([
      {
        channelId: 'dm-3',
        type: 'one_to_one',
        members: [{ user_id: editor.user_id }, { user_id: peer.user_id }]
      }
    ]);
    from = app.eventStore.events.length;
    assert.equal((await patch(editor.accesskey, { username: 'editor_three' })).statusCode, 200);
    assert.deepEqual(emitted(from), []);

    // so is a usernameKey change: nobody else can observe it
    from = app.eventStore.events.length;
    assert.equal((await patch(editor.accesskey, { usernameKey: '1234' })).statusCode, 200);
    assert.deepEqual(emitted(from), []);
  });

  test('a channel-ms outage does not fail the edit', async () => {
    const editor = await signupWithUsername(app, {
      phone: '+919500000009',
      username: 'editor_four'
    });
    const original = app.server.channelClient.get;
    app.server.channelClient.get = async () => {
      throw new Error('channel-ms is down');
    };
    const from = app.eventStore.events.length;
    const res = await patch(editor.accesskey, { displayName: 'Written anyway' });
    app.server.channelClient.get = original;

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.payload).displayName, 'Written anyway');
    assert.deepEqual(emitted(from), []);
  });
});
