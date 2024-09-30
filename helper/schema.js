const Joi = require('joi');

module.exports = {
  authHeaders: Joi.object({
    user: Joi.string().required(),
    accesskey: Joi.string().required(),
  }).unknown(true),
};
