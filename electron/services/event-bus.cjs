const { EventEmitter } = require('events');
const { assertDomainEvent } = require('../contracts/domain-events.cjs');

const createEventBus = () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  return {
    emit: (eventName, payload) => emitter.emit(eventName, payload),
    publish: event => {
      const validated = assertDomainEvent(event);
      emitter.emit('domain-event', validated);
      emitter.emit(validated.type, validated);
      return validated;
    },
    on: (eventName, listener) => {
      emitter.on(eventName, listener);
      return () => emitter.off(eventName, listener);
    },
    once: (eventName, listener) => emitter.once(eventName, listener),
    clear: () => emitter.removeAllListeners(),
  };
};

module.exports = { createEventBus };
