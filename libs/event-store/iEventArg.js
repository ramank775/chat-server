/**
 * @abstract
 * Abstract class for Event arguments
 */
class IEventArg {
  /**
   * Serialize the event arguments in binary format. (protobuf)
   * @returns {Buffer}
   */

  toBinary() {
    throw new Error('Not Implemented Exception');
  }

  /**
   * Serialize the event arguments in plain text format. (json)
   * @returns {string}
   */

  toString() {
    throw new Error('Not Implemented Exception');
  }

  /**
   * Static helper function to deserialize event data from binary format.
   * @return {IEventArg}
   */
  static fromBinary(_payload) {
    throw new Error('Not Implemented Exception');
  }

  /**
   * Static helper function to deserialize event data from plain text format.
   * @return {IEventArg}
   */
  static fromString(_payload) {
    throw new Error('Not Implemented Exception');
  }
}

module.exports = {
  IEventArg,
};
