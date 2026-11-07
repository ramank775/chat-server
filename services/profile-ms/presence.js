/**
 * SYNC_PROTOCOL §22 — who may see a user's last seen and online.
 *
 * Each user picks `everyone`, `contacts`, `nobody`, or a list of user ids
 * (`presenceUsers`): `only` those of their contacts, or their contacts
 * `except` those. null is the default, `everyone`, as on WhatsApp.
 * "Contacts" are the accepted connections (decision 219); a block, either
 * way, hides it whatever the setting. The phone builds the list from its
 * labels; the server never sees a label (decision 226).
 */
const PRESENCE = ['everyone', 'contacts', 'nobody', 'only', 'except'];
/** The settings that carry `presenceUsers`. */
const PRESENCE_LISTED = ['only', 'except'];
/** A family's labels, not an address book. */
const PRESENCE_USERS_MAX = 1000;

/** Whether `user` shares their presence with `other` (a contact or not). */
function shares(user, other, contact) {
  const listed = (user.presenceUsers || []).includes(other.user_id);
  switch (user.presence || 'everyone') {
    case 'everyone': return true;
    case 'contacts': return contact;
    case 'only': return contact && listed;
    case 'except': return contact && !listed;
    default: return false;
  }
}

/**
 * WhatsApp's reciprocity: `viewer` sees `target`'s presence only while each
 * shares theirs with the other. Hide yours from someone and you cannot see
 * theirs.
 * @param {{user_id?: string, presence?: string, presenceUsers?: string[]}} target
 * @param {{user_id?: string, presence?: string, presenceUsers?: string[]}} viewer
 * @param {boolean} contacts whether the two are connected
 * @param {boolean} [blocked] whether either blocked the other
 */
function canSee(target, viewer, contacts, blocked = false) {
  return !blocked && shares(target, viewer, contacts) && shares(viewer, target, contacts);
}

module.exports = {
  PRESENCE, PRESENCE_LISTED, PRESENCE_USERS_MAX, canSee
};
