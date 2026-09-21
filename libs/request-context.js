const { AsyncLocalStorage } = require('async_hooks');

/**
 * Request scoped store (`{ requestId }`). `libs/http-service-base` enters it once
 * per request, around the whole lifecycle, so every await, timer and callback
 * below it still reads the same id.
 */
const als = new AsyncLocalStorage();

/** @returns {string|undefined} the current request id, if we are inside a request */
function getRequestId() {
  const store = als.getStore();
  return store && store.requestId;
}

module.exports = {
  als,
  getRequestId
};
