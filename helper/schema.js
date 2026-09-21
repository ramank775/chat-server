const Joi = require('joi');

module.exports = {
  // nginx sets these after the /auth subrequest (AUTH_CONTRACT §6).
  authHeaders: Joi.object({
    'x-user': Joi.string().pattern(/^[0-9a-f]{9}$/).required(),
    'x-device': Joi.string(),
  }).unknown(true)
}
