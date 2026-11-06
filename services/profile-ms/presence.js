/**
 * SYNC_PROTOCOL §22 — who may see a user's last seen and online.
 *
 * Each user picks `everyone`, `contacts` or `nobody` (null is the default,
 * `everyone`, as on WhatsApp). "Contacts" are, for now, users who have each
 * written to the other in a DM; accepted connections replace that once
 * invites exist.
 */
const PRESENCE = ['everyone', 'contacts', 'nobody'];

/** Whether `user` shares their presence with someone (a contact or not). */
function shares(user, contact) {
  const setting = user.presence || 'everyone';
  return setting === 'everyone' || (setting === 'contacts' && contact);
}

/**
 * WhatsApp's reciprocity: `viewer` sees `target`'s presence only while each
 * shares theirs with the other. Hide yours from someone and you cannot see
 * theirs.
 * @param {{presence?: string}} target
 * @param {{presence?: string}} viewer
 * @param {boolean} contacts whether the two are contacts
 */
function canSee(target, viewer, contacts) {
  return shares(target, contacts) && shares(viewer, contacts);
}

module.exports = { PRESENCE, canSee };
