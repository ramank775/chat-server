const Joi = require('joi');

module.exports = {
  authHeaders: Joi.object({
    token: Joi.string().required(),
    accesskey: Joi.string().required(),
  }).unknown(true)
}
