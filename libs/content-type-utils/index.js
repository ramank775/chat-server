const mappings = require('./content-type.mapping.json');

const defaultContentType = mappings[0]['context-type'];

/**
 * A mapping record can list several extensions in one field (".jpeg, .jpg"),
 * so index every extension it names. Keys are stored without the leading dot.
 * Records dedicated to a single extension are indexed first, so ".xml" keeps
 * application/xml rather than losing to the earlier ".atom, .xml" record; ties
 * within a pass go to the first record naming the extension.
 * @type {Map<string, string>}
 */
const contentTypeByExt = new Map();
const extsOf = (record) => String(record.ext || '')
  .split(',')
  .map((entry) => entry.trim().toLowerCase().replace(/^\./, ''))
  .filter(Boolean);

[1, 2].forEach((pass) => {
  mappings.forEach((record) => {
    const exts = extsOf(record);
    if ((pass === 1) !== (exts.length === 1)) return;
    exts.forEach((ext) => {
      if (!contentTypeByExt.has(ext)) contentTypeByExt.set(ext, record['context-type']);
    });
  });
});

/**
 * Content type for a file extension, with or without the leading dot
 * @param {string} ext
 * @returns {string}
 */
module.exports.getContentTypeByExt = (ext) => {
  const key = String(ext || '').trim().toLowerCase().replace(/^\./, '');
  return contentTypeByExt.get(key) || defaultContentType;
};
