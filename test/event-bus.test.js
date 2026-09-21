const test = require('node:test');
const assert = require('node:assert');
const { MemoryEventBus } = require('../libs/event-store/memory');

const { describe, it } = test;

/** A handler that records what it got and takes `delayMs` to do it. */
function recorder(log, name, delayMs = 0) {
  return async (event, args) => {
    if (delayMs) await new Promise((resolve) => { setTimeout(resolve, delayMs); });
    log.push(`${name}:${event}:${args}`);
  };
}

const noError = () => { };

describe('the in-process event bus', () => {
  it('delivers a topic to every subscriber and to no other topic', async () => {
    const bus = new MemoryEventBus();
    const log = [];
    bus.subscribe('new-message', recorder(log, 'delivery'));
    bus.subscribe('new-message', recorder(log, 'audit'));
    bus.subscribe('offline-message', recorder(log, 'notification'));

    await bus.publish('new-message', 'one', 'key', noError);
    await bus.publish('offline-message', 'two', 'key', noError);

    assert.deepEqual(log.sort(), [
      'audit:new-message:one',
      'delivery:new-message:one',
      'notification:offline-message:two'
    ]);
  });

  it('never runs a handler synchronously inside publish', () => {
    const bus = new MemoryEventBus();
    let ran = false;
    bus.subscribe('topic', async () => { ran = true; });
    bus.publish('topic', 'payload', 'key', noError);
    assert.equal(ran, false, 'the handler ran on the publisher stack');
  });

  it('keeps the publish order of a topic even when a handler is slow', async () => {
    const bus = new MemoryEventBus();
    const log = [];
    // the first event takes the longest: without the per topic chain it would
    // finish last
    bus.subscribe('topic', async (_event, args) => {
      await new Promise((resolve) => { setTimeout(resolve, 15 - args * 5); });
      log.push(args);
    });

    bus.publish('topic', 1, 'key', noError);
    bus.publish('topic', 2, 'key', noError);
    await bus.publish('topic', 3, 'key', noError);

    assert.deepEqual(log, [1, 2, 3]);
  });

  it('isolates a throwing handler from its peers and from the next event', async () => {
    const bus = new MemoryEventBus();
    const log = [];
    const errors = [];
    bus.subscribe('topic', async () => { throw new Error('handler blew up'); });
    bus.subscribe('topic', recorder(log, 'peer'));

    await bus.publish('topic', 'one', 'key', (error) => errors.push(error.message));
    await bus.publish('topic', 'two', 'key', (error) => errors.push(error.message));

    assert.deepEqual(log, ['peer:topic:one', 'peer:topic:two']);
    assert.deepEqual(errors, ['handler blew up', 'handler blew up']);
  });

  it('stops delivering once a subscriber unsubscribes', async () => {
    const bus = new MemoryEventBus();
    const log = [];
    const unsubscribe = bus.subscribe('topic', recorder(log, 'consumer'));
    await bus.publish('topic', 'one', 'key', noError);
    unsubscribe();
    await bus.publish('topic', 'two', 'key', noError);
    assert.deepEqual(log, ['consumer:topic:one']);
  });
});
